from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

from dreampulse.clients.airia import AiriaClient
from dreampulse.clients.clickhouse import ClickHouseClient
from dreampulse.clients.freepik import FreepikVideoClient
from dreampulse.services.pipeline import generate_dream_video
from dreampulse.services.storage import persist_pipeline_result

logging.basicConfig(level=logging.INFO)


def load_env() -> None:
    env_path = Path(".env")
    if env_path.exists():
        load_dotenv(env_path)
    else:
        load_dotenv()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a dream analysis video with Freepik")
    parser.add_argument("dream", help="Dream text to analyze")
    parser.add_argument(
        "--duration",
        type=int,
        default=6,
        choices=[6, 10],
        help="Video duration in seconds",
    )
    parser.add_argument(
        "--download",
        dest="download_path",
        default=None,
        help="Optional path to save the generated video",
    )
    parser.add_argument(
        "--model",
        default="minimax-hailuo-02-768p",
        help="Freepik text-to-video model identifier",
    )
    parser.add_argument(
        "--prompt-url",
        dest="prompt_url",
        default=None,
        help="Override the Airia prompt pipeline URL (defaults to AIRIA_PROMPT_PIPELINE_URL)",
    )
    parser.add_argument(
        "--prompt-user-id",
        dest="prompt_user_id",
        default=None,
        help="User identifier forwarded to the prompt pipeline",
    )
    parser.add_argument(
        "--store-clickhouse",
        dest="store_clickhouse",
        action="store_true",
        help="Persist the result into ClickHouse if credentials are configured",
    )
    parser.add_argument(
        "--clickhouse-table",
        dest="clickhouse_table",
        default=None,
        help="ClickHouse table name override (defaults to CLICKHOUSE_TABLE)",
    )
    return parser.parse_args()


def main() -> None:
    load_env()
    args = parse_args()

    airia_url = os.environ.get("AIRIA_PIPELINE_URL")
    airia_key = os.environ.get("AIRIA_API_KEY")
    freepik_key = os.environ.get("FREEPIK_API_KEY")
    prompt_url = args.prompt_url or os.environ.get("AIRIA_PROMPT_PIPELINE_URL")
    prompt_user_id = args.prompt_user_id or os.environ.get("AIRIA_USER_ID")

    if not airia_url or not airia_key:
        raise RuntimeError("AIRIA_PIPELINE_URL and AIRIA_API_KEY must be set")
    if not freepik_key:
        raise RuntimeError("FREEPIK_API_KEY must be set")

    airia_client = AiriaClient(base_url=airia_url, api_key=airia_key)
    prompt_client = AiriaClient(base_url=prompt_url, api_key=airia_key) if prompt_url else None
    freepik_client = FreepikVideoClient(api_key=freepik_key)

    result = generate_dream_video(
        args.dream,
        airia_client=airia_client,
        freepik_client=freepik_client,
        prompt_client=prompt_client,
        prompt_user_id=prompt_user_id,
        freepik_options={
            "duration": args.duration,
            "download_path": args.download_path,
            "model": args.model,
        },
    )

    logging.info("Dream analysis: %s", result["analysis"])
    logging.info("Prompt source: %s", result.get("prompt_source"))
    logging.info("Video prompt: %s", result["prompt"])
    logging.info("Freepik video task: %s", result["video"])

    if args.store_clickhouse:
        clickhouse_url = os.environ.get("CLICKHOUSE_URL")
        clickhouse_user = os.environ.get("CLICKHOUSE_USER")
        clickhouse_password = os.environ.get("CLICKHOUSE_PASSWORD")
        clickhouse_db = os.environ.get("CLICKHOUSE_DATABASE", "default")
        table = args.clickhouse_table or os.environ.get("CLICKHOUSE_TABLE", "dreampulse_dreams")

        if not clickhouse_url or not clickhouse_user or not clickhouse_password:
            raise RuntimeError("CLICKHOUSE_URL, CLICKHOUSE_USER, and CLICKHOUSE_PASSWORD must be set when using --store-clickhouse")

        clickhouse_client = ClickHouseClient(
            base_url=clickhouse_url,
            username=clickhouse_user,
            password=clickhouse_password,
            database=clickhouse_db,
        )
        clickhouse_client.create_table_if_not_exists(table)
        record = persist_pipeline_result(clickhouse_client, table, args.dream, result)
        logging.info("ClickHouse record id: %s", record["id"])


if __name__ == "__main__":
    main()
