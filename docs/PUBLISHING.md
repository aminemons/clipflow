# Publishing and human approval

Clipflow keeps social publishing behind two separate actions. Exporting a
clip does not approve it, and approving a clip does not publish it. An approval
records the exact clip revision and the immutable export artifact URL. Editing
the clip or replacing the export makes that approval stale.

The local API is registered with `backend.publishing.register(app, store,
locks=None, context=None)`. `context` can provide a `providers` mapping for a
host or test adapter; production uses the built in providers. Publishing state
is stored in `data/publishing_state.json`. Provider credentials are stored in
`data/publishing_settings.json`, written atomically with private mode (0600 on
platforms that support it). Credentials are never returned by the settings
GET endpoint.

## Settings

`GET /api/publishing/settings` returns safe status only:

```json
{
  "providers": {
    "youtube": {
      "enabled": false,
      "configured": false,
      "has_access_token": false,
      "has_refresh_token": false,
      "has_client_id": false,
      "has_client_secret": false,
      "privacy_default": "private"
    },
    "instagram": {
      "enabled": false,
      "configured": false,
      "has_access_token": false,
      "public_base_url_configured": false,
      "account_id": "",
      "public_base_url": ""
    },
    "tiktok": {
      "enabled": false,
      "configured": false,
      "has_access_token": false,
      "has_client_key": false,
      "public_base_url_configured": false,
      "public_base_url": "",
      "audit_approved": false
    }
  },
  "notes": {}
}
```

`PUT /api/publishing/settings` accepts provider objects. Secret fields are
write-only and an empty value preserves the existing secret:

```json
{
  "youtube": {
    "enabled": true,
    "privacy_default": "private",
    "access_token": "...",
    "refresh_token": "...",
    "client_id": "...",
    "client_secret": "..."
  },
  "instagram": {
    "enabled": true,
    "account_id": "professional-account-id",
    "access_token": "...",
    "public_base_url": "https://media.example.test"
  },
  "tiktok": {
    "enabled": false,
    "access_token": "...",
    "client_key": "...",
    "public_base_url": "https://media.example.test",
    "audit_approved": false,
    "disable_duet": false,
    "disable_comment": false,
    "disable_stitch": false
  }
}
```

## Approval, prepare, and confirmation

Approve exported clips with:

```http
POST /api/projects/{project_id}/approvals
Content-Type: application/json

{"clip_ids":["clip-id"],"action":"approve"}
```

Use `action:"revoke"` to remove an approval. Bulk approval validates every
clip before changing any approval row.

`GET /api/projects/{project_id}/approvals` returns rows containing
`clip_id`, `revision`, `current_revision`, `artifact_url`, and `valid`.
Approval is rejected until the clip has a completed immutable export under
`/exports/{export_job}/{clip_id}/download`.

Prepare a reviewable plan:

```json
{
  "clip_ids": ["clip-id"],
  "platforms": ["youtube", "instagram"],
  "captions": {
    "youtube": "A YouTube description",
    "instagram": {"clip-id": "A Reel caption"}
  },
  "titles": {"clip-id": "Optional YouTube title"},
  "privacy": {"youtube": "private"}
}
```

`POST /api/projects/{project_id}/publish/prepare` returns an opaque `plan_id`,
the required `confirmation_token`, an `expires_at` timestamp, and `targets`.
Each target includes the platform, clip ID, exact revision, caption, privacy,
and immutable artifact URL. The token and target snapshot are persisted on the
server and expire after 15 minutes.

Actual delivery requires a separate HTTP request with the literal phrase:

```http
POST /api/publishing/confirm
Content-Type: application/json

{"plan_id":"opaque-plan-id","confirmation_token":"opaque-token-from-prepare","confirmation":"PUBLISH"}
```

Confirmation rechecks every approval, revision, artifact path, expiry, and
provider configuration. Each platform/clip target receives one persisted
attempt. A second confirmation, an edited clip, a stale export, or a missing
credential is rejected. `GET /api/publishing/history` returns attempts with
`queued`, `running`, `processing`, `succeeded`, `failed`, `disabled`, or
`uncertain` status.
For TikTok `processing` or `uncertain` attempts, `POST
/api/publishing/history/{attempt_id}/refresh` checks the existing provider
publish ID only and never starts a second upload.
An uncertain result means the request may have reached the provider and is
never automatically retried; inspect the provider before any manual action.

## Provider prerequisites and policy boundaries

YouTube uses OAuth 2.0 and `videos.insert` with a resumable upload session. The
minimal upload scope is `https://www.googleapis.com/auth/youtube.upload`.
See the [official upload guide](https://developers.google.com/youtube/v3/guides/uploading_a_video)
and [resumable protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).

Instagram uses the Graph API professional account Reel flow: create a `REELS`
container with `video_url`, then call `/{ig-user-id}/media_publish`. The video
URL must be HTTPS and reachable by Meta, so a local filesystem URL is not
accepted. The account must be a professional account with the required Meta
permissions; see Meta's [Content Publishing guide](https://developers.facebook.com/docs/instagram-api/guides/content-publishing/). The adapter waits for the container's `FINISHED` status before publishing and reads the resulting Graph `permalink`.

TikTok Direct Post is policy gated. The Content Posting API requires the
creator authorization scope, a creator-info query, and an audited Direct Post
client before visibility restrictions are lifted. Clipflow disables Direct
Post until `audit_approved` is explicitly supplied. Creator privacy options
and duet/comment/stitch disabled flags are applied from creator metadata and
local settings. The adapter polls final post status and never invents a
successful TikTok post; before audit, use TikTok's supported upload or manual
delivery flow. See the [official Direct Post guide](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
and [status reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status).

No provider is contacted during approval or plan preparation. A network error
after a publish request has started is recorded as `uncertain` and requires
operator verification rather than a blind retry.
