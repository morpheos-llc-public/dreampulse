from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

from dreampulse.clients.airia import AiriaClient
from dreampulse.clients.freepik import FreepikVideoClient

PromptBuilder = Callable[[Dict[str, Any], str], str]

logger = logging.getLogger(__name__)


def generate_dream_video(
    dream_text: str,
    *,
    airia_client: AiriaClient,
    freepik_client: FreepikVideoClient,
    prompt_builder: Optional[PromptBuilder] = None,
    prompt_client: Optional[AiriaClient] = None,
    prompt_user_id: Optional[str] = None,
    freepik_options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    analysis = airia_client.execute_pipeline(dream_text)

    prompt_source = "fallback_builder"
    prompt_response: Optional[Dict[str, Any]] = None
    prompt_text: Optional[str] = None

    if prompt_client and isinstance(analysis, dict):
        try:
            prompt_response = prompt_client.execute_pipeline(
                analysis, async_output=False, user_id=prompt_user_id
            )
            prompt_text = _extract_prompt_text(prompt_response)
            if prompt_text:
                prompt_source = "airia_prompt_pipeline"
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Prompt pipeline failed; falling back to heuristic builder", exc_info=exc)

    if not prompt_text:
        builder = prompt_builder or _default_prompt_builder
        prompt_text = builder(analysis if isinstance(analysis, dict) else {}, dream_text)

    if not prompt_text or not prompt_text.strip():
        raise ValueError("Video prompt cannot be empty")

    video_result = freepik_client.generate_video(prompt_text, **(freepik_options or {}))
    return {
        "analysis": analysis,
        "prompt": prompt_text,
        "prompt_source": prompt_source,
        "prompt_pipeline_response": prompt_response,
        "video": video_result,
    }


def _default_prompt_builder(analysis: Dict[str, Any], fallback: str) -> str:
    candidate_keys = [
        "video_prompt",
        "visual_prompt",
        "videoPrompt",
        "visualPrompt",
        "scene_description",
        "sceneDescription",
        "result",
        "summary",
    ]

    for key in candidate_keys:
        value = analysis.get(key)
        if isinstance(value, str) and value.strip():
            return value

    for key, value in analysis.items():
        if isinstance(value, dict):
            nested_value = _extract_string_from_dict(value, candidate_keys)
            if nested_value:
                return nested_value

    return fallback


def _extract_string_from_dict(data: Dict[str, Any], candidate_keys: list[str]) -> str:
    for key in candidate_keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _extract_prompt_text(response: Dict[str, Any]) -> str:
    candidates = [
        "prompt",
        "video_prompt",
        "result",
        "freepik_prompt",
        "description",
    ]
    for key in candidates:
        value = response.get(key)
        if isinstance(value, str) and value.strip():
            return value
    # Handle nested payloads
    for key, value in response.items():
        if isinstance(value, dict):
            nested = _extract_prompt_text(value)
            if nested:
                return nested
    return ""
