"""Provider adapters + factory for image/video/voice backends.

Prefer ``providers.factory.submit_image|submit_video|poll_*`` over importing
individual adapters from tools/platform code.
"""

from evoflow.community.media_generation.providers import factory

__all__ = ["factory"]
