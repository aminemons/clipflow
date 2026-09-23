from backend.media import srt_for_clip


def test_word_timing_keeps_captions_on_speech_and_respects_clip_edges():
    transcript = [{
        "start": 0,
        "end": 6,
        "text": "A clear idea. Then the payoff.",
        "words": [
            {"start": 0.4, "end": 0.7, "text": "A"},
            {"start": 0.8, "end": 1.1, "text": "clear"},
            {"start": 1.2, "end": 1.6, "text": "idea."},
            {"start": 3.0, "end": 3.3, "text": "Then"},
            {"start": 3.4, "end": 3.6, "text": "the"},
            {"start": 3.7, "end": 4.2, "text": "payoff."},
        ],
    }]
    clip = {"start": 0, "end": 5, "playback_speed": 1}
    captions = srt_for_clip(clip, transcript)
    assert "00:00:00,400 --> 00:00:01,600\nA clear idea." in captions
    assert "00:00:03,000 --> 00:00:04,200\nThen the payoff." in captions
    assert "00:00:01,600 --> 00:00:03,000" not in captions

    clipped = srt_for_clip({"start": 2.9, "end": 5}, transcript)
    assert "A clear idea" not in clipped
    assert "00:00:00,100 --> 00:00:01,300\nThen the payoff." in clipped


def test_corrected_transcript_uses_current_text_instead_of_stale_word_data():
    transcript = [{
        "start": 0,
        "end": 2,
        "text": "The corrected name",
        "words": [
            {"start": 0.3, "end": 0.6, "text": "The"},
            {"start": 0.7, "end": 1.0, "text": "wrong"},
            {"start": 1.1, "end": 1.5, "text": "name"},
        ],
    }]
    captions = srt_for_clip({"start": 0, "end": 2}, transcript)
    assert "The corrected name" in captions
    assert "The wrong name" not in captions


def test_silent_padding_does_not_show_a_word_aligned_caption():
    transcript = [{
        "start": 0,
        "end": 3,
        "text": "Spoken later",
        "words": [
            {"start": 2, "end": 2.3, "text": "Spoken"},
            {"start": 2.4, "end": 2.8, "text": "later"},
        ],
    }]
    assert srt_for_clip({"start": 0, "end": 1}, transcript) == ""


def test_word_cues_scale_with_playback_speed():
    transcript = [{
        "start": 10,
        "end": 12,
        "text": "first second",
        "words": [
            {"start": 10.2, "end": 10.5, "text": "first"},
            {"start": 10.6, "end": 11.2, "text": "second"},
        ],
    }]
    clip = {"start": 10, "end": 12, "playback_speed": 2}
    assert "00:00:00,100 --> 00:00:00,600" in srt_for_clip(clip, transcript)
    assert "00:00:00,200 --> 00:00:01,200" in srt_for_clip(clip, transcript, for_render=True)
