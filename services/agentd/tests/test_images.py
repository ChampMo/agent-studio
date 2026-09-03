"""An image on the way to a model (§12 M9.3).

Two APIs, two completely different shapes for the same idea — OpenAI wants a
parts array with a data URI, Anthropic wants content blocks with base64 and a
separate media type. Neither is wrapped in a shim that pretends they are the
same (§15 row 17), so each adapter renders it and each is asserted here against
the shape its API documents.

The third test is the one that protects everything else: a message with no
images has to come out exactly as it did before, because every existing
conversation goes through this code on every turn.
"""

from __future__ import annotations

from agentd.providers.anthropic_provider import _messages as anthropic_messages
from agentd.providers.base import ChatRequest, ImagePart, Message
from agentd.providers.openai_compatible import _messages as openai_messages

PNG = ImagePart(media_type="image/png", data_b64="aGVsbG8=")


def req(*messages: Message) -> ChatRequest:
    return ChatRequest(model="m", messages=list(messages), max_tokens=1024)


def test_openai_gets_a_parts_array_with_a_data_uri():
    out = openai_messages(req(Message("user", "what is wrong with this?", images=(PNG,))))
    content = out[-1]["content"]

    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "what is wrong with this?"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"] == "data:image/png;base64,aGVsbG8="


def test_anthropic_gets_blocks_with_the_image_first():
    # The documented order, and the one that reads as "here is the picture, now
    # my question about it".
    out = anthropic_messages(req(Message("user", "what is wrong with this?", images=(PNG,))))
    content = out[-1]["content"]

    assert isinstance(content, list)
    assert content[0]["type"] == "image"
    assert content[0]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": "aGVsbG8=",
    }
    assert content[1] == {"type": "text", "text": "what is wrong with this?"}


def test_a_message_without_images_is_unchanged():
    """The regression guard. Every turn of every existing conversation goes
    through this code, and an endpoint that has never seen a picture must still
    receive the plain string it has always been sent."""
    plain = req(Message("user", "hello"))

    assert openai_messages(plain)[-1]["content"] == "hello"
    assert anthropic_messages(plain)[-1]["content"] == "hello"


def test_several_images_all_travel():
    second = ImagePart(media_type="image/jpeg", data_b64="d29ybGQ=")
    out = openai_messages(req(Message("user", "compare these", images=(PNG, second))))
    kinds = [part["type"] for part in out[-1]["content"]]
    assert kinds == ["text", "image_url", "image_url"]


def test_an_image_with_no_words_still_goes():
    # Dropping a screenshot in with nothing typed is a perfectly ordinary way
    # to ask "what is this?", so an empty text part must not be invented.
    out = openai_messages(req(Message("user", "", images=(PNG,))))
    assert [part["type"] for part in out[-1]["content"]] == ["image_url"]

    blocks = anthropic_messages(req(Message("user", "", images=(PNG,))))[-1]["content"]
    assert [block["type"] for block in blocks] == ["image"]
