import json
import io
import xml.etree.ElementTree as ET
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend import app as api
from backend.nle_export import prepare, stream_package
from backend.store import Store


def _project(source_id="project-a"):
    return {
        "id": source_id,
        "title": "A 'safe' project",
        "duration": 12,
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "transcript": [{"start": 1, "end": 2, "text": "hello there"}],
        "clips": [
            {
                "id": "clip-a",
                "title": "A 'clip'",
                "start": 1,
                "end": 4,
                "selected": True,
                "playback_speed": 1,
                "caption_text": "",
                "caption_enabled": True,
                "caption_color": "#ffffff",
                "caption_size": 50,
                "caption_x": 0.5,
                "caption_y": 0.86,
                "resolution": 720,
                "aspect_ratio": "9:16",
            }
        ],
    }


def _archive(stream):
    return zipfile.ZipFile(io.BytesIO(b"".join(stream)))


def test_package_has_xml_srt_jsx_manifest_and_source_once(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"tiny media bytes")
    project = _project()
    with _archive(stream_package(project, project["clips"], source, has_audio=True)) as archive:
        assert archive.namelist().count("media/source.mp4") == 1
        assert set(archive.namelist()) == {
            "media/source.mp4", "Premiere.xml", "captions.srt",
            "after-effects.jsx", "manifest.json", "README.txt",
        }
        assert archive.read("media/source.mp4") == b"tiny media bytes"
        root = ET.fromstring(archive.read("Premiere.xml"))
        assert root.tag == "xmeml"
        assert root.findtext("sequence/duration") == "90"
        assert root.findtext("sequence/media/video/format/samplecharacteristics/width") == "720"
        assert root.findtext("sequence/media/video/format/samplecharacteristics/height") == "1280"
        assert len(root.findall(".//video/track/clipitem")) == 1
        assert len(root.findall(".//audio/track/clipitem")) == 1
        clip = root.find(".//video/track/clipitem")
        assert clip.findtext("in") == "30"
        assert clip.findtext("out") == "120"
        assert "hello there" in archive.read("captions.srt").decode()
        jsx = archive.read("after-effects.jsx").decode()
        assert "addText(cue.text)" in jsx
        assert '"/media/" + data.media' in jsx
        assert "Clipflow crop/reframe" in archive.read("README.txt").decode()
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["source_media"] == "media/source.mp4"


def test_package_uses_fixed_archive_names_and_json_safe_jsx(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"data")
    project = _project()
    project["title"] = "x'); alert('bad"
    project["clips"][0]["caption_text"] = "It's \"quoted\"\\safe"
    project["clips"][0]["caption_color"] = "'); alert('bad"
    with _archive(stream_package(project, project["clips"], source, has_audio=False)) as archive:
        assert all(".." not in name and "\\" not in name for name in archive.namelist())
        jsx = archive.read("after-effects.jsx").decode()
        assert "alert('bad')" not in jsx
        assert "var data = {" in jsx
        assert "JSON.parse" not in jsx
        assert all(ord(char) < 128 for char in jsx)
        assert '"captionColor": "#ffffff"' in jsx


def test_prepare_rejects_bad_ids_timing_and_missing_source(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"data")
    project = _project()
    with pytest.raises(ValueError):
        prepare(project, [{**project["clips"][0], "id": "../clip"}], source)
    with pytest.raises(ValueError):
        prepare(project, [{**project["clips"][0], "end": 0}], source)
    with pytest.raises(FileNotFoundError):
        prepare(project, project["clips"], tmp_path / "missing.mp4")


def test_endpoint_returns_selected_package_and_validates_requested_ids(tmp_path, monkeypatch):
    source_store = Store(tmp_path)
    source_store.files.mkdir(parents=True, exist_ok=True)
    (source_store.files / "project-a.mp4").write_bytes(b"tiny media")
    source_store.save(_project())
    monkeypatch.setattr(api, "store", source_store)
    monkeypatch.setattr(api, "ensure_workspace_space", lambda _required=0: None)
    monkeypatch.setattr(api.media, "probe", lambda _source: {"streams": [{"codec_type": "video"}]})
    client = TestClient(api.app)

    response = client.get("/api/projects/project-a/edit-package?clip_ids=clip-a")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/zip")
    assert "project-a-adobe-handoff.zip" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read("media/project-a.mp4") == b"tiny media"
        assert ET.fromstring(archive.read("Premiere.xml")).find("sequence/media/audio") is None
    assert [p.name for p in source_store.files.iterdir()] == ["project-a.mp4"]
    assert client.get("/api/projects/project-a/edit-package?clip_ids=missing").status_code == 404
    assert client.get("/api/projects/project-a/edit-package?clip_ids=../bad").status_code == 400


def test_fractional_rate_is_nominal_ntsc_and_out_is_exclusive(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"tiny")
    project = _project()
    project["fps"] = 29.97
    with _archive(stream_package(project, project["clips"], source, has_audio=False)) as archive:
        root = ET.fromstring(archive.read("Premiere.xml"))
        assert root.findtext("sequence/rate/timebase") == "30"
        assert root.findtext("sequence/rate/ntsc") == "TRUE"
        clip = root.find(".//video/track/clipitem")
        assert clip.findtext("out") == str(round(4 * 29.97))


def test_sequence_srt_uses_raw_source_time_when_premiere_omits_speed(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"tiny")
    project = _project()
    project["clips"][0]["playback_speed"] = 2
    with _archive(stream_package(project, project["clips"], source, has_audio=False)) as archive:
        srt = archive.read("captions.srt").decode()
        assert "00:00:00,000 --> 00:00:01,000" in srt
        jsx = archive.read("after-effects.jsx").decode()
        assert "layer.stretch = 100 / clip.speed" in jsx
        assert "layer.startTime = -clip.start / clip.speed" in jsx


def test_stream_close_cancels_without_staging_archive(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"x" * (2 * 1024 * 1024))
    stream = stream_package(_project(), _project()["clips"], source, has_audio=False)
    next(stream)
    stream.close()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.mp4"]
