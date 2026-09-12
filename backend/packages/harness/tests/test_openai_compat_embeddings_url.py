"""URL builder for OpenAI-compatible embedding endpoints."""

from evoflow.knowledge.embedding.base import openai_compat_embeddings_url


def test_openai_host_gets_v1_embeddings() -> None:
    assert (
        openai_compat_embeddings_url("https://api.openai.com")
        == "https://api.openai.com/v1/embeddings"
    )


def test_openai_v1_base_not_doubled() -> None:
    assert (
        openai_compat_embeddings_url("https://api.openai.com/v1")
        == "https://api.openai.com/v1/embeddings"
    )


def test_ark_api_v3_no_extra_v1() -> None:
    assert (
        openai_compat_embeddings_url("https://ark.cn-beijing.volces.com/api/v3")
        == "https://ark.cn-beijing.volces.com/api/v3/embeddings"
    )


def test_ark_agent_plan_base() -> None:
    assert (
        openai_compat_embeddings_url(
            "https://ark.cn-beijing.volces.com/api/plan/v3"
        )
        == "https://ark.cn-beijing.volces.com/api/plan/v3/embeddings"
    )


def test_ark_coding_plan_base() -> None:
    assert (
        openai_compat_embeddings_url(
            "https://ark.cn-beijing.volces.com/api/coding/v3"
        )
        == "https://ark.cn-beijing.volces.com/api/coding/v3/embeddings"
    )


def test_full_embeddings_url_passthrough() -> None:
    url = "https://ark.cn-beijing.volces.com/api/v3/embeddings"
    assert openai_compat_embeddings_url(url) == url


def test_multimodal_suffix() -> None:
    assert (
        openai_compat_embeddings_url(
            "https://ark.cn-beijing.volces.com/api/v3",
            multimodal=True,
        )
        == "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal"
    )


def test_agent_plan_vision_uses_multimodal() -> None:
    from evoflow.knowledge.embedding.cloud_provider import _is_multimodal_embedding_model

    plan = "https://ark.cn-beijing.volces.com/api/plan/v3"
    assert _is_multimodal_embedding_model("doubao-embedding-vision", plan)
    assert not _is_multimodal_embedding_model("doubao-embedding", plan)
    coding = "https://ark.cn-beijing.volces.com/api/coding/v3"
    assert not _is_multimodal_embedding_model("doubao-embedding-vision", coding)
