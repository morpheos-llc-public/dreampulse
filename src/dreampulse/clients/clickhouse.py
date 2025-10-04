from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)


@dataclass
class ClickHouseClient:
    """Tiny helper around the ClickHouse HTTP interface."""

    base_url: str
    username: str
    password: str
    database: str = "default"
    session: Optional[requests.Session] = None
    timeout: int = 30

    def __post_init__(self) -> None:
        self._session = self.session or requests.Session()
        self._session.auth = (self.username, self.password)

    def execute(self, query: str, *, data: Optional[str] = None) -> requests.Response:
        params = {"database": self.database, "query": query}
        logger.debug("Executing ClickHouse query", extra={"query": query})
        response = self._session.post(self.base_url, params=params, data=data, timeout=self.timeout)
        response.raise_for_status()
        return response

    def create_table_if_not_exists(self, table: str) -> None:
        qualified = self._qualify(table)
        ddl = f"""
        CREATE TABLE IF NOT EXISTS {qualified} (
            id UUID,
            dream_text String,
            analysis_json String,
            prompt String,
            prompt_source String,
            prompt_pipeline_json String,
            freepik_video_url String,
            freepik_task_json String,
            created_at DateTime
        )
        ENGINE = MergeTree
        ORDER BY (created_at, id)
        """.strip()
        self.execute(ddl)

    def insert_json_rows(self, table: str, rows: List[Dict[str, Any]]) -> None:
        if not rows:
            return
        qualified = self._qualify(table)
        query = f"INSERT INTO {qualified} FORMAT JSONEachRow"
        payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
        self.execute(query, data=payload.encode("utf-8"))

    def _qualify(self, table: str) -> str:
        return f"{self.database}.{table}" if "." not in table else table
