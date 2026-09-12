"""Tests for core functions in volcengine_speech.py (credentials, URL routing, error handling, HTTP calls).

Covers:
- _normalize_key, _is_agent_plan_key
- _resolve_api_key (env var -> media_settings fallback chain)
- _load_credentials (integration of apply + get + fallback)
- speech_configured, _require_credentials, get_enabled_vendors_safe
- _speech_headers
- _tts_url, _asr_flash_url, _asr_ws_url, _asr_ws_async_url
- _is_agent_plan_deduct_error, _format_tts_business_error, _raise_tts_business_error
- _asr_uses_streaming
- _parse_tts_ndjson
- synthesize_speech_v3 (mock httpx)
- _parse_asr_flash_response, _raise_asr_http_error
- transcribe_audio_flash (mock httpx)
"""

from __future__ import annotations

import json
import os
from unittest.mock import ANY, MagicMock, patch

import httpx
import pytest

from app.gateway.speech.volcengine_speech import (
    ASR_FLASH_URL_AGENT_PLAN,
    ASR_FLASH_URL_STANDARD,
    ASR_WS_ASYNC_AGENT_PLAN,
    ASR_WS_ASYNC_STANDARD,
    ASR_WS_NOSTREAM_AGENT_PLAN,
    ASR_WS_NOSTREAM_STANDARD,
    TTS_URL_AGENT_PLAN,
    TTS_URL_STANDARD,
    _asr_flash_url,
    _asr_uses_streaming,
    _asr_ws_async_url,
    _asr_ws_url,
    _format_tts_business_error,
    _is_agent_plan_deduct_error,
    _is_agent_plan_key,
    _load_credentials,
    _normalize_key,
    _parse_asr_flash_response,
    _parse_tts_ndjson,
    _raise_asr_http_error,
    _raise_tts_business_error,
    _require_credentials,
    _resolve_api_key,
    _speech_headers,
    _tts_url,
    get_enabled_vendors_safe,
    speech_configured,
    synthesize_speech_v3,
    transcribe_audio_flash,
)

# =============================================================================
# _normalize_key
# =============================================================================


class TestNormalizeKey:
    def test_normalize_trims_whitespace(self):
        assert _normalize_key("  abc  ") == "abc"

    def test_normalize_strips_quotes(self):
        assert _normalize_key('"abc"') == "abc"
        assert _normalize_key("'abc'") == "abc"

    def test_normalize_handles_none(self):
        assert _normalize_key(None) == ""

    def test_normalize_empty(self):
        assert _normalize_key("") == ""

    def test_normalize_combined(self):
        assert _normalize_key('  "ark-xxx"  ') == "ark-xxx"


# =============================================================================
# _is_agent_plan_key
# =============================================================================


class TestIsAgentPlanKey:
    def test_ark_prefix(self):
        assert _is_agent_plan_key("ark-abc123") is True

    def test_ark_prefix_case_insensitive(self):
        assert _is_agent_plan_key("ARK-ABC123") is True

    def test_non_ark_key(self):
        assert _is_agent_plan_key("sk-abc123") is False

    def test_empty_key(self):
        assert _is_agent_plan_key("") is False

    def test_normalized_ark_key(self):
        assert _is_agent_plan_key('  "ark-xxx"  ') is True


# =============================================================================
# _resolve_api_key
# =============================================================================


class TestResolveApiKey:
    @patch.dict(os.environ, {'VOLCENGINE_SPEECH_API_KEY': 'env-key-1'}, clear=True)
    def test_env_var_volcengine_speech_api_key(self):
        assert _resolve_api_key({}) == 'env-key-1'

    @patch.dict(os.environ, {'BYTEPLUS_SEED_SPEECH_API_KEY': 'env-key-2'}, clear=True)
    def test_env_var_byteplus_seed_speech_api_key(self):
        assert _resolve_api_key({}) == 'env-key-2'

    @patch.dict(os.environ, {}, clear=True)
    def test_creds_fallback(self):
        creds = {'volcengineSpeechApiKey': 'creds-key'}
        assert _resolve_api_key(creds) == 'creds-key'

    @patch.dict(os.environ, {}, clear=True)
    def test_creds_volcengine_api_key(self):
        creds = {'volcengineApiKey': 'volc-key'}
        assert _resolve_api_key(creds) == 'volc-key'

    @patch.dict(os.environ, {'VOLCENGINE_TTS_ACCESS_TOKEN': 'token-key'}, clear=True)
    def test_env_var_tts_access_token(self):
        assert _resolve_api_key({}) == 'token-key'

    @patch.dict(os.environ, {}, clear=True)
    def test_all_empty_returns_empty(self):
        assert _resolve_api_key({}) == ''

    @patch.dict(os.environ, {'VOLCENGINE_SPEECH_API_KEY': '  ark-xxx  '}, clear=True)
    def test_env_var_normalized(self):
        assert _resolve_api_key({}) == 'ark-xxx'


# =============================================================================
# _load_credentials
# =============================================================================


class TestLoadCredentials:
    @patch('evoflow.persistence.media_settings.apply_media_credentials_to_environ')
    @patch('evoflow.persistence.media_settings.get_media_credentials')
    @patch.dict(os.environ, {'VOLCENGINE_SPEECH_API_KEY': 'ark-tts-key'}, clear=True)
    def test_agent_plan_credentials(
        self, mock_get_creds, mock_apply
    ):
        mock_get_creds.return_value = {
            'volcengineTtsResourceId': 'seed-tts-2.0',
            'volcengineTtsSpeaker': 'zh_female_vv_uranus_bigtts',
            'volcengineAsrResourceId': 'volc.seedasr.sauc.duration',
        }
        result = _load_credentials()
        mock_apply.assert_called_once()
        assert result[0] == 'ark-tts-key'
        assert result[1] == 'seed-tts-2.0'
        assert result[2] == 'zh_female_vv_uranus_bigtts'
        assert result[3] == 'volc.seedasr.sauc.duration'
        assert result[4] is True

    @patch('evoflow.persistence.media_settings.apply_media_credentials_to_environ')
    @patch('evoflow.persistence.media_settings.get_media_credentials')
    @patch.dict(os.environ, {'VOLCENGINE_SPEECH_API_KEY': 'sk-standard-key'}, clear=True)
    def test_standard_credentials(
        self, mock_get_creds, mock_apply
    ):
        mock_get_creds.return_value = {}
        result = _load_credentials()
        assert result[0] == 'sk-standard-key'
        assert result[1] == 'seed-tts-2.0'
        assert result[2] == 'zh_female_vv_uranus_bigtts'
        assert result[3] == 'volc.bigasr.auc_turbo'
        assert result[4] is False

    @patch('evoflow.persistence.media_settings.apply_media_credentials_to_environ')
    @patch('evoflow.persistence.media_settings.get_media_credentials')
    @patch.dict(os.environ, {}, clear=True)
    def test_empty_credentials_returns_empty(
        self, mock_get_creds, mock_apply
    ):
        mock_get_creds.return_value = {}
        result = _load_credentials()
        assert result[0] == ''
        assert result[4] is False


# =============================================================================
# speech_configured / get_enabled_vendors_safe
# =============================================================================


class TestSpeechConfigured:
    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors')
    @patch('app.gateway.speech.volcengine_speech._load_credentials')
    def test_configured_returns_true(
        self, mock_load, mock_vendors
    ):
        mock_vendors.return_value = {'volcengine-tts': True}
        mock_load.return_value = ('ark-key', 'r', 's', 'a', True)
        assert speech_configured() is True

    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors')
    @patch('app.gateway.speech.volcengine_speech._load_credentials')
    def test_disabled_vendor_returns_false(
        self, mock_load, mock_vendors
    ):
        mock_vendors.return_value = {'volcengine-tts': False}
        mock_load.return_value = ('ark-key', 'r', 's', 'a', True)
        assert speech_configured() is False

    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors')
    @patch('app.gateway.speech.volcengine_speech._load_credentials')
    def test_missing_key_returns_false(
        self, mock_load, mock_vendors
    ):
        mock_vendors.return_value = {'volcengine-tts': True}
        mock_load.return_value = ('', 'r', 's', 'a', False)
        assert speech_configured() is False


class TestGetEnabledVendorsSafe:
    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors')
    def test_enabled(self, mock_vendors):
        mock_vendors.return_value = {'volcengine-tts': True}
        assert get_enabled_vendors_safe() is True

    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors')
    def test_disabled(self, mock_vendors):
        mock_vendors.return_value = {'volcengine-tts': False}
        assert get_enabled_vendors_safe() is False


# =============================================================================
# _require_credentials
# =============================================================================


class TestRequireCredentials:
    @patch('app.gateway.speech.volcengine_speech._load_credentials')
    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors_safe')
    def test_ok(self, mock_vendors, mock_load):
        mock_vendors.return_value = True
        mock_load.return_value = ('ark-key', 'r', 's', 'a', True)
        result = _require_credentials()
        assert result == ('ark-key', 'r', 's', 'a', True)

    @patch('app.gateway.speech.volcengine_speech._load_credentials')
    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors_safe')
    def test_no_api_key_raises(self, mock_vendors, mock_load):
        mock_vendors.return_value = True
        mock_load.return_value = ('', 'r', 's', 'a', False)
        with pytest.raises(ValueError, match='\u8bed\u97f3 API Key'):
            _require_credentials()

    @patch('app.gateway.speech.volcengine_speech._load_credentials')
    @patch('app.gateway.speech.volcengine_speech.get_enabled_vendors_safe')
    def test_vendor_disabled_raises(self, mock_vendors, mock_load):
        mock_vendors.return_value = False
        mock_load.return_value = ('ark-key', 'r', 's', 'a', True)
        with pytest.raises(ValueError, match='\u706b\u5c71 TTS vendor'):
            _require_credentials()


# =============================================================================
# _speech_headers
# =============================================================================


class TestSpeechHeaders:
    def test_basic_headers(self):
        h = _speech_headers(api_key='key-1', resource_id='seed-tts-2.0')
        assert h['Content-Type'] == 'application/json'
        assert h['X-Api-Key'] == 'key-1'
        assert h['X-Api-Resource-Id'] == 'seed-tts-2.0'
        assert 'X-Api-Request-Id' not in h

    def test_with_request_id(self):
        h = _speech_headers(api_key='key-1', resource_id='r1', request_id='req-123')
        assert h['X-Api-Request-Id'] == 'req-123'
        assert h['X-Api-Sequence'] == '-1'


# =============================================================================
# URL routing helpers
# =============================================================================


class TestUrlRouting:
    def test_tts_url_agent_plan(self):
        assert _tts_url(True) == TTS_URL_AGENT_PLAN

    def test_tts_url_standard(self):
        assert _tts_url(False) == TTS_URL_STANDARD

    def test_asr_flash_url_agent_plan(self):
        assert _asr_flash_url(True) == ASR_FLASH_URL_AGENT_PLAN

    def test_asr_flash_url_standard(self):
        assert _asr_flash_url(False) == ASR_FLASH_URL_STANDARD

    def test_asr_ws_url_agent_plan(self):
        assert _asr_ws_url(True) == ASR_WS_NOSTREAM_AGENT_PLAN

    def test_asr_ws_url_standard(self):
        assert _asr_ws_url(False) == ASR_WS_NOSTREAM_STANDARD

    def test_asr_ws_async_url_agent_plan(self):
        assert _asr_ws_async_url(True) == ASR_WS_ASYNC_AGENT_PLAN

    def test_asr_ws_async_url_standard(self):
        assert _asr_ws_async_url(False) == ASR_WS_ASYNC_STANDARD


# =============================================================================
# _is_agent_plan_deduct_error
# =============================================================================


class TestIsAgentPlanDeductError:
    def test_exact_marker(self):
        assert _is_agent_plan_deduct_error('AgentPlanDeductNotEnabled') is True

    def test_english_marker(self):
        assert _is_agent_plan_deduct_error('Agent Plan deduction is not enabled') is True

    def test_chinese_marker(self):
        assert _is_agent_plan_deduct_error('\u672a\u5f00\u901a Agent Plan') is True

    def test_non_deduct_error(self):
        assert _is_agent_plan_deduct_error('rate limit exceeded') is False

    def test_empty_message(self):
        assert _is_agent_plan_deduct_error('') is False

    def test_none_message(self):
        assert _is_agent_plan_deduct_error(None) is False


# =============================================================================
# _format_tts_business_error / _raise_tts_business_error
# =============================================================================


class TestFormatTtsBusinessError:
    def test_agent_plan_deduct(self):
        msg = _format_tts_business_error(
            45000030,
            'Forbidden.AgentPlanDeductNotEnabled',
        )
        assert 'AgentPlanDeductNotEnabled' in msg
        assert 'seed-tts-2.0' in msg

    def test_other_error(self):
        msg = _format_tts_business_error(400, 'bad request')
        assert 'TTS error code=400' in msg


class TestRaiseTtsBusinessError:
    def test_deduct_raises_value_error(self):
        with pytest.raises(ValueError, match='AgentPlanDeductNotEnabled'):
            _raise_tts_business_error(45000030, 'AgentPlanDeductNotEnabled')

    def test_other_raises_runtime_error(self):
        with pytest.raises(RuntimeError, match='TTS error code=500'):
            _raise_tts_business_error(500, 'internal error')


# =============================================================================
# _asr_uses_streaming
# =============================================================================


class TestAsrUsesStreaming:
    def test_seedasr_sauc_duration(self):
        assert _asr_uses_streaming('volc.seedasr.sauc.duration') is True

    def test_seedasr_sauc_concurrent(self):
        assert _asr_uses_streaming('volc.seedasr.sauc.concurrent') is True

    def test_bigasr_sauc_duration(self):
        assert _asr_uses_streaming('volc.bigasr.sauc.duration') is True

    def test_bigasr_auc_turbo_not_streaming(self):
        assert _asr_uses_streaming('volc.bigasr.auc_turbo') is False

    def test_sauc_but_not_turbo(self):
        assert _asr_uses_streaming('custom.sauc.v1') is True

    def test_empty_string(self):
        assert _asr_uses_streaming('') is False


# =============================================================================
# _parse_tts_ndjson
# =============================================================================


class TestParseTtsNdjson:
    def test_single_chunk(self):
        data_b64 = 'AAAA'
        body = json.dumps({'code': 0, 'data': data_b64})
        result = _parse_tts_ndjson(body)
        assert result == b'\x00\x00\x00'

    def test_multiple_chunks(self):
        chunk1 = json.dumps({'code': 0, 'data': 'AQID'})
        chunk2 = json.dumps({'code': 0, 'data': 'BAUG'})
        body = chunk1 + '\n' + chunk2
        result = _parse_tts_ndjson(body)
        assert result == b'\x01\x02\x03\x04\x05\x06'

    def test_skip_done_marker(self):
        body = json.dumps({'code': 0, 'data': 'AQID'}) + '\n[DONE]\n'
        result = _parse_tts_ndjson(body)
        assert result == b'\x01\x02\x03'

    def test_end_of_stream_code(self):
        chunk = json.dumps({'code': 0, 'data': 'AQID'})
        end = json.dumps({'code': 20000000})
        body = chunk + '\n' + end
        result = _parse_tts_ndjson(body)
        assert result == b'\x01\x02\x03'

    def test_business_error_raises(self):
        body = json.dumps({'code': 45000030, 'message': 'AgentPlanDeductNotEnabled'})
        with pytest.raises(ValueError, match='AgentPlanDeductNotEnabled'):
            _parse_tts_ndjson(body)

    def test_empty_body_raises(self):
        with pytest.raises(RuntimeError, match='empty audio'):
            _parse_tts_ndjson('')

    def test_only_done_raises(self):
        with pytest.raises(RuntimeError, match='empty audio'):
            _parse_tts_ndjson('[DONE]')

    def test_non_json_line_skipped(self):
        chunk = json.dumps({'code': 0, 'data': 'AQID'})
        body = 'not json\n' + chunk
        result = _parse_tts_ndjson(body)
        assert result == b'\x01\x02\x03'


# =============================================================================
# synthesize_speech_v3 (mock httpx)
# =============================================================================


class TestSynthesizeSpeechV3:
    @patch('app.gateway.speech.volcengine_speech._require_credentials')
    @patch('app.gateway.speech.volcengine_speech.httpx.Client')
    def test_success_standard_key(
        self, mock_client_cls, mock_require
    ):
        mock_require.return_value = ('sk-key', 'seed-tts-2.0', 'zh_female_vv_uranus_bigtts', 'volc.bigasr.auc_turbo', False)
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({'code': 0, 'data': 'AQID'})
        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        audio, speaker = synthesize_speech_v3('\u4f60\u597d\u4e16\u754c')
        assert audio == b'\x01\x02\x03'
        assert speaker == 'zh_female_vv_uranus_bigtts'
        mock_client.post.assert_called_once_with(
            TTS_URL_STANDARD,
            json=ANY,
            headers=ANY,
        )

    @patch('app.gateway.speech.volcengine_speech._require_credentials')
    @patch('app.gateway.speech.volcengine_speech.httpx.Client')
    def test_success_agent_plan(
        self, mock_client_cls, mock_require
    ):
        mock_require.return_value = ('ark-key', 'seed-tts-2.0', 'zh_female_vv_uranus_bigtts', 'volc.seedasr.sauc.duration', True)
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({'code': 0, 'data': 'AQID'})
        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        audio, speaker = synthesize_speech_v3('\u4f60\u597d\u4e16\u754c')
        assert audio == b'\x01\x02\x03'
        call_url = mock_client.post.call_args[0][0]
        assert call_url == TTS_URL_AGENT_PLAN

    @patch('app.gateway.speech.volcengine_speech._require_credentials')
    @patch('app.gateway.speech.volcengine_speech.httpx.Client')
    def test_http_error_raises(
        self, mock_client_cls, mock_require
    ):
        mock_require.return_value = ('sk-key', 'seed-tts-2.0', 'spk', 'res', False)
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 401
        mock_resp.text = 'Unauthorized'
        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        with pytest.raises(RuntimeError, match='TTS HTTP 401'):
            synthesize_speech_v3('test')

    @patch('app.gateway.speech.volcengine_speech._require_credentials')
    @patch('app.gateway.speech.volcengine_speech.httpx.Client')
    def test_with_speaker_and_preview(
        self, mock_client_cls, mock_require
    ):
        mock_require.return_value = ('sk-key', 'seed-tts-2.0', 'default_spk', 'res', False)
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({'code': 0, 'data': 'AQID'})
        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        audio, speaker = synthesize_speech_v3('test', speaker='zh_male_sunwukong_uranus_bigtts', preview=True)
        assert audio == b'\x01\x02\x03'
        assert speaker == 'zh_male_sunwukong_uranus_bigtts'
        call_kwargs = mock_client.post.call_args[1]
        payload = call_kwargs['json']
        assert 'additions' in payload['req_params']


# =============================================================================
# _parse_asr_flash_response
# =============================================================================


class TestParseAsrFlashResponse:
    def test_success_text(self):
        resp = MagicMock(spec=httpx.Response)
        resp.headers = {'X-Api-Status-Code': '20000000'}
        resp.json.return_value = {'result': {'text': 'hello world'}}
        assert _parse_asr_flash_response(resp) == 'hello world'

    def test_success_top_level_text(self):
        resp = MagicMock(spec=httpx.Response)
        resp.headers = {}
        resp.json.return_value = {'text': 'direct text'}
        assert _parse_asr_flash_response(resp) == 'direct text'

    def test_success_utterances(self):
        resp = MagicMock(spec=httpx.Response)
        resp.headers = {}
        resp.json.return_value = {
            'result': {
                'utterances': [
                    {'text': 'hello '},
                    {'text': 'world'},
                ]
            }
        }
        assert _parse_asr_flash_response(resp) == 'hello world'

    def test_status_code_error(self):
        resp = MagicMock(spec=httpx.Response)
        resp.headers = {'X-Api-Status-Code': '45000010'}
        resp.text = 'Invalid key'
        with pytest.raises(RuntimeError, match='ASR failed'):
            _parse_asr_flash_response(resp)

    def test_empty_transcript_raises(self):
        resp = MagicMock(spec=httpx.Response)
        resp.headers = {}
        resp.json.return_value = {'result': {}}
        with pytest.raises(RuntimeError, match='empty transcript'):
            _parse_asr_flash_response(resp)

    def test_invalid_json_raises(self):
        resp = MagicMock(spec=httpx.Response)
        resp.headers = {}
        resp.json.side_effect = ValueError('bad json')
        resp.text = '{bad json}'
        with pytest.raises(RuntimeError, match='ASR invalid JSON'):
            _parse_asr_flash_response(resp)


# =============================================================================
# _raise_asr_http_error
# =============================================================================


class TestRaiseAsrHttpError:
    def test_invalid_key_standard(self):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 401
        resp.text = 'Invalid X-Api-Key'
        resp.json.side_effect = ValueError()
        with pytest.raises(ValueError, match='\u8bed\u97f3 API Key \u65e0\u6548'):
            _raise_asr_http_error(resp, agent_plan=False)

    def test_invalid_key_agent_plan(self):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 401
        resp.text = 'Invalid X-Api-Key'
        resp.json.side_effect = ValueError()
        with pytest.raises(ValueError, match='Agent Plan'):
            _raise_asr_http_error(resp, agent_plan=True)

    def test_other_error(self):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 500
        resp.text = 'Internal server error'
        resp.json.side_effect = ValueError()
        with pytest.raises(RuntimeError, match='ASR HTTP 500'):
            _raise_asr_http_error(resp, agent_plan=False)

    def test_json_header_error(self):
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 400
        resp.text = '{"header": {"code": 45000010, "message": "Invalid X-Api-Key"}}'
        resp.json.return_value = {'header': {'code': 45000010, 'message': 'Invalid X-Api-Key'}}
        with pytest.raises(ValueError, match='\u8bed\u97f3 API Key \u65e0\u6548'):
            _raise_asr_http_error(resp, agent_plan=False)


# =============================================================================
# transcribe_audio_flash (mock httpx)
# =============================================================================


class TestTranscribeAudioFlash:
    @patch('app.gateway.speech.volcengine_speech._require_credentials')
    @patch('app.gateway.speech.volcengine_speech._asr_uses_streaming')
    @patch('app.gateway.speech.volcengine_speech.httpx.Client')
    def test_flash_success(
        self,
        mock_client_cls,
        mock_streaming,
        mock_require,
    ):
        mock_require.return_value = ('sk-key', 'tts-r', 'spk', 'volc.bigasr.auc_turbo', False)
        mock_streaming.return_value = False
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.headers = {}
        mock_resp.json.return_value = {'result': {'text': 'transcribed text'}}
        mock_client = MagicMock()
        mock_client.__enter__.return_value = mock_client
        mock_client.post.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        result = transcribe_audio_flash(b'fake audio bytes')
        assert result == 'transcribed text'
        mock_client.post.assert_called_once_with(
            ASR_FLASH_URL_STANDARD,
            json=ANY,
            headers=ANY,
        )

    @patch('app.gateway.speech.volcengine_speech._require_credentials')
    @patch('app.gateway.speech.volcengine_speech._asr_uses_streaming')
    @patch('app.gateway.speech.volcengine_speech.transcribe_audio_nostream_ws')
    def test_streaming_route(
        self,
        mock_ws,
        mock_streaming,
        mock_require,
    ):
        mock_require.return_value = ('ark-key', 'tts-r', 'spk', 'volc.seedasr.sauc.duration', True)
        mock_streaming.return_value = True
        mock_ws.return_value = 'ws transcribed'

        result = transcribe_audio_flash(b'fake audio bytes')
        assert result == 'ws transcribed'
        mock_ws.assert_called_once_with(
            audio_bytes=b'fake audio bytes',
            api_key='ark-key',
            resource_id='volc.seedasr.sauc.duration',
            ws_url=ASR_WS_NOSTREAM_AGENT_PLAN,
        )
