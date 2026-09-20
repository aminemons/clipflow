import { useEffect, useState } from "react";
import { ExternalLink, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import "./PublishingSettings.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Platform = "youtube" | "instagram" | "tiktok";
type ProviderStatus = {
  id?: string;
  label?: string;
  enabled: boolean;
  configured: boolean;
  accounts?: ProviderStatus[];
  [key: string]: boolean | string | ProviderStatus[] | undefined;
};
type SettingsResponse = { providers: Record<Platform, ProviderStatus>; notes: Record<string, string> };
type AccountForm = {
  id: string; label: string; enabled: boolean; privacy_default: string; account_id: string;
  access_token: string; refresh_token: string; client_id: string; client_secret: string;
  public_base_url: string; client_key: string; audit_approved: boolean;
  disable_duet: boolean; disable_comment: boolean; disable_stitch: boolean;
};
type Form = Record<Platform, AccountForm[]>;

const emptyAccount = (platform: Platform, index = 0): AccountForm => ({
  id: `${platform}-${index + 1}`, label: `${platform[0].toUpperCase()}${platform.slice(1)} account ${index + 1}`,
  enabled: false, privacy_default: "private", account_id: "", access_token: "", refresh_token: "", client_id: "", client_secret: "", public_base_url: "", client_key: "", audit_approved: false, disable_duet: false, disable_comment: false, disable_stitch: false,
});
const emptyForm: Form = { youtube: [], instagram: [], tiktok: [] };
const platformCopy: Record<Platform, { title: string; description: string; docs: string }> = {
  youtube: { title: "YouTube", description: "Keep separate channels ready for the same approved export.", docs: "https://developers.google.com/youtube/v3/guides/uploading_a_video" },
  instagram: { title: "Instagram Reels", description: "Each professional account needs its own Meta credentials and public media URL.", docs: "https://developers.facebook.com/docs/instagram-api/guides/content-publishing/" },
  tiktok: { title: "TikTok Direct Post", description: "Direct Post stays disabled until each Content Posting API client passes audit.", docs: "https://developers.tiktok.com/docs/en/content-posting-api-get-started" },
};

function Credential({ label, value, present, onChange }: { label: string; value: string; present?: boolean; onChange: (value: string) => void }) {
  return <label className="publishing-field">{label}<input type="password" autoComplete="new-password" value={value} placeholder={present ? "Saved · enter to replace" : "Not configured"} onChange={(event) => onChange(event.target.value)} /><small>{present ? "Saved with this workspace; never returned by the API." : "Write only. Leave blank to keep it unchanged."}</small></label>;
}
function Status({ status }: { status?: ProviderStatus }) {
  if (!status) return <span className="publishing-status is-muted">Not configured</span>;
  return <span className={`publishing-status ${status.configured && status.enabled ? "is-ready" : "is-muted"}`}>{status.configured && status.enabled ? "Ready" : status.configured ? "Connected · disabled" : "Not configured"}</span>;
}
function fromStatus(platform: Platform, status: ProviderStatus): AccountForm {
  const account = emptyAccount(platform);
  return { ...account, id: String(status.id || account.id), label: String(status.label || status.id || account.label), enabled: !!status.enabled, privacy_default: String(status.privacy_default || "private"), account_id: String(status.account_id || ""), public_base_url: String(status.public_base_url || ""), audit_approved: !!status.audit_approved, disable_duet: !!status.disable_duet, disable_comment: !!status.disable_comment, disable_stitch: !!status.disable_stitch };
}

export default function PublishingSettings({ api, onNotice }: { api: Api; onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      setError("");
      const next = await api<SettingsResponse>("/publishing/settings");
      setSettings(next);
      const mapped = (Object.keys(platformCopy) as Platform[]).reduce((result, platform) => {
        const provider = next.providers[platform];
        const statuses = provider?.accounts?.length ? provider.accounts : provider ? [provider] : [];
        result[platform] = statuses.map((status) => { const existing = form[platform].find((item) => item.id === status.id); return { ...(existing || emptyAccount(platform)), ...fromStatus(platform, status) }; });
        return result;
      }, { ...emptyForm } as Form);
      setForm(mapped);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Publishing settings are unavailable."); }
  }
  useEffect(() => { void load(); }, []);
  function update(platform: Platform, index: number, value: Partial<AccountForm>) { setForm((current) => ({ ...current, [platform]: current[platform].map((account, i) => i === index ? { ...account, ...value } : account) })); }
  function add(platform: Platform) { setForm((current) => { const account = emptyAccount(platform, current[platform].length); account.id = `${platform}-${Date.now().toString(36)}`; return { ...current, [platform]: [...current[platform], account] }; }); }
  function remove(platform: Platform, index: number) { setForm((current) => ({ ...current, [platform]: current[platform].filter((_, i) => i !== index) })); }
  async function save() {
    setSaving(true); setError("");
    try {
      const body = (Object.keys(platformCopy) as Platform[]).reduce((result, platform) => {
        result[platform] = { accounts: form[platform].map((account) => { const { id, label, enabled, privacy_default, account_id, access_token, refresh_token, client_id, client_secret, public_base_url, client_key, audit_approved, disable_duet, disable_comment, disable_stitch } = account; return { id: id.trim(), label: label.trim(), enabled, privacy_default, ...(account_id.trim() ? { account_id: account_id.trim() } : {}), ...(access_token ? { access_token } : {}), ...(refresh_token ? { refresh_token } : {}), ...(client_id ? { client_id } : {}), ...(client_secret ? { client_secret } : {}), ...(public_base_url.trim() ? { public_base_url: public_base_url.trim() } : {}), ...(client_key ? { client_key } : {}), audit_approved, disable_duet, disable_comment, disable_stitch }; }) };
        return result;
      }, {} as Record<Platform, { accounts: object[] }>);
      setSettings(await api<SettingsResponse>("/publishing/settings", { method: "PUT", body: JSON.stringify(body) }));
      setForm((current) => ({ ...current, youtube: current.youtube.map((a) => ({ ...a, access_token: "", refresh_token: "", client_id: "", client_secret: "" })), instagram: current.instagram.map((a) => ({ ...a, access_token: "" })), tiktok: current.tiktok.map((a) => ({ ...a, access_token: "", client_key: "" })) }));
      onNotice("Publishing accounts saved");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save publishing settings."); } finally { setSaving(false); }
  }
  return <section className="publishing-settings" aria-label="Publishing account settings">
    <div className="publishing-settings-heading"><div><h2>Publishing accounts</h2><p>Connect as many channels as you need. Credentials stay in the local Clipflow data folder and are write only.</p></div><button className="primary-action" disabled={saving} onClick={save}><Save size={16} />{saving ? "Saving…" : "Save publishing settings"}</button></div>
    {error && <p className="workspace-error" role="alert">{error}</p>}
    {(Object.keys(platformCopy) as Platform[]).map((platform) => <article className="publishing-provider-card" key={platform}>
      <header><div><h3>{platformCopy[platform].title}</h3><p>{platformCopy[platform].description}</p></div><button className="secondary-action" type="button" onClick={() => add(platform)}><Plus size={15} />Add account</button></header>
      {!form[platform].length && <p className="publishing-empty-account">No account connected yet.</p>}
      {form[platform].map((account, index) => { const status = settings?.providers[platform]?.accounts?.find((item) => item.id === account.id) || (index === 0 ? settings?.providers[platform] : undefined); return <div className="publishing-account" key={`${platform}-${account.id}-${index}`}>
        <div className="publishing-account-heading"><div><strong>{account.label || "Unnamed account"}</strong><small>{account.id}</small></div><Status status={status} /><button className="icon-action" type="button" aria-label={`Remove ${account.label || "account"}`} onClick={() => remove(platform, index)}><Trash2 size={15} /></button></div>
        <div className="publishing-fields"><label className="publishing-field">Account name<input value={account.label} onChange={(event) => update(platform, index, { label: event.target.value })} /></label><label className="publishing-field">Account ID<input value={account.id} onChange={(event) => update(platform, index, { id: event.target.value })} /><small>Use letters, numbers, underscore, or hyphen.</small></label><label className="publishing-toggle"><input type="checkbox" checked={account.enabled} onChange={(event) => update(platform, index, { enabled: event.target.checked })} /> Enable</label>
          {platform === "youtube" && <><label className="publishing-field">Default visibility<select value={account.privacy_default} onChange={(event) => update(platform, index, { privacy_default: event.target.value })}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></label><Credential label="Access token" value={account.access_token} present={!!status?.has_access_token} onChange={(value) => update(platform, index, { access_token: value })} /><Credential label="Refresh token" value={account.refresh_token} present={!!status?.has_refresh_token} onChange={(value) => update(platform, index, { refresh_token: value })} /><label className="publishing-field">OAuth client ID<input value={account.client_id} placeholder={status?.has_client_id ? "Saved · enter to replace" : "Client ID"} onChange={(event) => update(platform, index, { client_id: event.target.value })} /></label><Credential label="OAuth client secret" value={account.client_secret} present={!!status?.has_client_secret} onChange={(value) => update(platform, index, { client_secret: value })} /></>}
          {platform === "instagram" && <><label className="publishing-field">Professional account ID<input value={account.account_id} placeholder="Instagram account ID" onChange={(event) => update(platform, index, { account_id: event.target.value })} /></label><Credential label="Access token" value={account.access_token} present={!!status?.has_access_token} onChange={(value) => update(platform, index, { access_token: value })} /><label className="publishing-field">Public base URL<input type="url" value={account.public_base_url} placeholder="https://media.example.com" onChange={(event) => update(platform, index, { public_base_url: event.target.value })} /><small>Clipflow appends the immutable export path for Meta to download.</small></label></>}
          {platform === "tiktok" && <><Credential label="Access token" value={account.access_token} present={!!status?.has_access_token} onChange={(value) => update(platform, index, { access_token: value })} /><Credential label="Client key" value={account.client_key} present={!!status?.has_client_key} onChange={(value) => update(platform, index, { client_key: value })} /><label className="publishing-field">Public base URL<input type="url" value={account.public_base_url} placeholder="https://media.example.com" onChange={(event) => update(platform, index, { public_base_url: event.target.value })} /></label><label className="publishing-toggle"><input type="checkbox" checked={account.audit_approved} onChange={(event) => update(platform, index, { audit_approved: event.target.checked })} /> My client has passed TikTok audit</label><div className="publishing-checks"><label><input type="checkbox" checked={account.disable_duet} onChange={(event) => update(platform, index, { disable_duet: event.target.checked })} /> Disable duet</label><label><input type="checkbox" checked={account.disable_comment} onChange={(event) => update(platform, index, { disable_comment: event.target.checked })} /> Disable comments</label><label><input type="checkbox" checked={account.disable_stitch} onChange={(event) => update(platform, index, { disable_stitch: event.target.checked })} /> Disable stitch</label></div></>}
        </div></div>; })}
      <a className="publishing-doc-link" href={platformCopy[platform].docs} target="_blank" rel="noreferrer">{platformCopy[platform].title} publishing docs <ExternalLink size={14} /></a>{platform === "tiktok" && <p className="publishing-policy-note"><ShieldCheck size={16} /> TikTok may restrict Direct Post visibility until audit.</p>}
    </article>)}
    {settings?.notes && <p className="publishing-notes">{Object.values(settings.notes).join(" ")}</p>}
  </section>;
}
