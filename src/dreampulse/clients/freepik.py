from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger(__name__)


FREEPIK_BASE_URL = "https://api.freepik.com/v1/ai"


@dataclass
class FreepikVideoClient:
    """Client helper for Freepik text-to-video models."""

    api_key: str
    session: Optional[requests.Session] = None

    def __post_init__(self) -> None:
        self._session = self.session or requests.Session()

    def generate_video(
        self,
        prompt: str,
        *,
        model: str = "minimax-hailuo-02-768p",
        duration: int = 6,
        prompt_optimizer: bool = True,
        timeout_seconds: int = 600,
        poll_interval: int = 3,
        download_path: Optional[str] = None,
        extra_payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        endpoint = f"{FREEPIK_BASE_URL}/image-to-video/{model}"
        headers = {"x-freepik-api-key": self.api_key, "Content-Type": "application/json"}
        payload: Dict[str, Any] = {
            "prompt": prompt,
            "duration": str(duration),
            "prompt_optimizer": prompt_optimizer,
        }
        if extra_payload:
            payload.update(extra_payload)

        logger.debug("Submitting Freepik video generation", extra={"endpoint": endpoint})
        response = self._session.post(endpoint, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        task = response.json()["data"]
        task_id = task["task_id"]

        status_endpoint = f"{endpoint}/{task_id}"
        start = time.time()
        status = task.get("status", "PENDING")
        while status not in {"COMPLETED", "FAILED"}:
            if time.time() - start > timeout_seconds:
                raise TimeoutError("Timed out waiting for Freepik video generation")
            time.sleep(poll_interval)
            status_response = self._session.get(status_endpoint, headers={"x-freepik-api-key": self.api_key}, timeout=30)
            status_response.raise_for_status()
            task = status_response.json()["data"]
            status = task.get("status", "PENDING")
            logger.debug("Freepik task status", extra={"task_id": task_id, "status": status})

        if status != "COMPLETED":
            raise RuntimeError(f"Freepik task {task_id} finished with status {status}")

        generated_urls = task.get("generated", [])
        if not generated_urls:
            raise ValueError("Freepik response did not include generated video URLs")
        video_url = generated_urls[0]

        file_path = None
        if download_path:
            file_path = self._download_video(video_url, download_path)

        return {"task_id": task_id, "status": status, "video_url": video_url, "file_path": file_path}

    def _download_video(self, url: str, file_path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)
        with self._session.get(url, stream=True, timeout=60) as response:
            response.raise_for_status()
            with open(file_path, "wb") as file:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        file.write(chunk)
        logger.info("Downloaded Freepik video", extra={"path": file_path})
        return file_path
