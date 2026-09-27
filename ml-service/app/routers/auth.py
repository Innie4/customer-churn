"""Request authentication for the ML service.

The service is internal: the Next.js application calls it, never the browser.
A shared API key keeps it that way. The key is compared in constant time and
the service can be configured to refuse to start without one.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from ..config import settings

API_KEY_HEADER = "x-ml-api-key"


def require_api_key(x_ml_api_key: str | None = Header(default=None)) -> None:
    """Reject a request that does not present the configured API key."""
    if not settings.api_key:
        # No key configured. In production ML_REQUIRE_API_KEY should be on; in
        # local development this keeps the service usable on its own.
        return

    if not x_ml_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing ML service API key.",
        )

    if not hmac.compare_digest(x_ml_api_key, settings.api_key):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid ML service API key.",
        )
