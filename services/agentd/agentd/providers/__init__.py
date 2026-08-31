"""Provider adapters.

Import from `registry`, never from a concrete provider module — that is the rule
that keeps `agents/runtime.py` vendor-agnostic (PROJECT_BRIEF.md §3.1), and
there is a test that enforces it.
"""

from .base import (
    Capabilities,
    ChatRequest,
    Chunk,
    DoneChunk,
    LLMProvider,
    Message,
    NoticeChunk,
    ProviderError,
    TextChunk,
    ToolCallChunk,
    ToolSpec,
    Usage,
)

__all__ = [
    "Capabilities",
    "ChatRequest",
    "Chunk",
    "DoneChunk",
    "LLMProvider",
    "Message",
    "NoticeChunk",
    "ProviderError",
    "TextChunk",
    "ToolCallChunk",
    "ToolSpec",
    "Usage",
]
