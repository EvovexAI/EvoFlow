import logging
import os

import requests

logger = logging.getLogger(__name__)


def jina_enabled() -> bool:
    """Jina Reader only when an API key is configured (avoids hanging on r.jina.ai)."""
    if str(os.getenv("EVOFLOW_DISABLE_JINA", "") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return False
    return bool(str(os.getenv("JINA_API_KEY", "") or "").strip())


class JinaClient:
    def crawl(self, url: str, return_format: str = "html", timeout: int = 10) -> str:
        api_key = str(os.getenv("JINA_API_KEY", "") or "").strip()
        if not jina_enabled():
            return "Error: Jina Reader disabled (set JINA_API_KEY to enable)"

        headers = {
            "Content-Type": "application/json",
            "X-Return-Format": return_format,
            "X-Timeout": str(timeout),
            "Authorization": f"Bearer {api_key}",
        }
        data = {"url": url}
        try:
            response = requests.post(
                "https://r.jina.ai/",
                headers=headers,
                json=data,
                timeout=max(1, int(timeout or 10)),
            )

            if response.status_code != 200:
                error_message = f"Jina API returned status {response.status_code}: {response.text}"
                logger.error(error_message)
                return f"Error: {error_message}"

            if not response.text or not response.text.strip():
                error_message = "Jina API returned empty response"
                logger.error(error_message)
                return f"Error: {error_message}"

            return response.text
        except Exception as e:
            error_message = f"Request to Jina API failed: {str(e)}"
            logger.error(error_message)
            return f"Error: {error_message}"
