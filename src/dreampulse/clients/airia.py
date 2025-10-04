from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


@dataclass
class AiriaClient:
    """Simple client around the Airia pipeline execution endpoint."""

    base_url: str
    api_key: str
    session: Optional[requests.Session] = None

    def __post_init__(self) -> None:
        self._session = self.session or requests.Session()
        self._session.headers.update(
            {
                "X-API-KEY": self.api_key,
                "Content-Type": "application/json",
            }
        )

    def execute_pipeline(
        self,
        user_input: Any,
        *,
        async_output: bool = False,
        user_id: Optional[str] = None,
        extra_payload: Optional[Dict[str, Any]] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"userInput": self._serialize_input(user_input), "asyncOutput": async_output}
        if user_id:
            payload["userId"] = user_id
        if extra_payload:
            payload.update(extra_payload)
        if extra:
            payload.update(extra)
        logger.debug("Sending payload to Airia pipeline", extra={"payload": payload})
        response = self._session.post(self.base_url, json=payload, timeout=60)
        response.raise_for_status()
        return self._normalize_response(response)

    def _serialize_input(self, user_input: Any) -> str:
        if isinstance(user_input, str):
            return user_input
        try:
            return json.dumps(user_input, ensure_ascii=False)
        except (TypeError, ValueError):
            logger.warning("Falling back to string serialization for user_input", extra={"type": type(user_input).__name__})
            return str(user_input)

    def _normalize_response(self, response: requests.Response) -> Dict[str, Any]:
        try:
            data: Any = response.json()
        except json.JSONDecodeError as exc:
            logger.error("Could not decode Airia response", exc_info=exc)
            raise

        if isinstance(data, dict) and "result" in data:
            normalized = data.get("result")
        else:
            normalized = data

        if isinstance(normalized, str):
            return {"result": normalized}

        if isinstance(normalized, dict):
            return normalized

        logger.warning("Unexpected Airia payload", extra={"payload": data})
        return {"result": normalized}
