"""The only module in the process allowed to touch a provider key.

PROJECT_BRIEF.md §9.2: keys live in the OS keychain, owned by Python. Tauri
never sees one. They must never reach localStorage, an env var, argv, SQLite, an
export file, or a log line — which is why nothing here ever returns a key into a
string that gets formatted into a message.
"""

from __future__ import annotations

import keyring
from keyring.errors import KeyringError

from .config import APP_NAME

SERVICE = APP_NAME


class SecretsUnavailable(RuntimeError):
    """The OS keychain could not be reached at all."""


def _account(profile_id: str) -> str:
    """One secret per provider profile, so two DeepSeek endpoints can differ."""
    return f"provider:{profile_id}"


def set_key(profile_id: str, key: str) -> None:
    key = key.strip()
    if not key:
        raise ValueError("refusing to store an empty key")
    try:
        keyring.set_password(SERVICE, _account(profile_id), key)
    except KeyringError as exc:  # pragma: no cover - platform dependent
        raise SecretsUnavailable(str(exc)) from exc


def get_key(profile_id: str) -> str | None:
    try:
        return keyring.get_password(SERVICE, _account(profile_id))
    except KeyringError as exc:  # pragma: no cover - platform dependent
        raise SecretsUnavailable(str(exc)) from exc


def has_key(profile_id: str) -> bool:
    """Whether a key exists. Never reveals the value — this is what the UI asks."""
    return get_key(profile_id) is not None


def delete_key(profile_id: str) -> bool:
    try:
        keyring.delete_password(SERVICE, _account(profile_id))
        return True
    except keyring.errors.PasswordDeleteError:
        return False
    except KeyringError as exc:  # pragma: no cover - platform dependent
        raise SecretsUnavailable(str(exc)) from exc
