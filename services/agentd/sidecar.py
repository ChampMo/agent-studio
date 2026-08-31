"""Frozen entrypoint for the packaged backend (PROJECT_BRIEF.md §12 M7).

PyInstaller runs its entry script as `__main__` at the top level, where
`agentd/__main__.py`'s relative imports have no package to resolve against and
the build fails on the first line it executes. Importing the package properly
here keeps `python -m agentd` and the sidecar on the same code, with no
`if getattr(sys, "frozen")` branches inside the app itself.
"""

from agentd.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
