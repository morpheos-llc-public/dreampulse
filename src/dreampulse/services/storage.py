from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Dict

from dreampulse.clients.clickhouse import ClickHouseClient


def build_clickhouse_record(dream_text: str, pipeline_result: Dict[str, Any]) -> Dict[str, Any]:
    video_info = pipeline_result.get("video") or {}
    record = {
        "id": str(uuid.uuid4()),
        "dream_text": dream_text,
        "analysis_json": json.dumps(pipeline_result.get("analysis"), ensure_ascii=False),
        "prompt": pipeline_result.get("prompt", ""),
        "prompt_source": pipeline_result.get("prompt_source", ""),
        "prompt_pipeline_json": json.dumps(pipeline_result.get("prompt_pipeline_response"), ensure_ascii=False)
        if pipeline_result.get("prompt_pipeline_response")
        else "",
        "freepik_video_url": video_info.get("video_url", ""),
        "freepik_task_json": json.dumps(video_info, ensure_ascii=False),
        "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
    }
    return record


def persist_pipeline_result(
    client: ClickHouseClient,
    table: str,
    dream_text: str,
    pipeline_result: Dict[str, Any],
) -> Dict[str, Any]:
    record = build_clickhouse_record(dream_text, pipeline_result)
    client.insert_json_rows(table, [record])
    return record
