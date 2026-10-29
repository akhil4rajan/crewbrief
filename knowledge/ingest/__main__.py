"""Ingest CLI.

    python -m knowledge.ingest --source ./knowledge/sources --index hazards [--target local|azure]

1. Validates ``hazard_library.yaml`` (schema, unique codes, every cross-referenced code and document
   file exists, keywords are lowercase, high-risk hazards have a qualifying control). Exits non-zero
   with every problem listed.
2. Chunks the safety documents and builds one search record per library entry and chunk.
3. ``local``: writes ``$DATA_DIR/search/index.json`` (read by ``LocalHazardSearch``).
   ``azure``: creates or updates the Azure AI Search index and uploads the records in batches.
   The target defaults to the configured search provider.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

from packages.common.config import Settings, get_settings
from packages.common.logging import configure_logging

from ..corpus import LibraryValidationError, SearchDocument, build_documents, load_and_validate
from ..search import azure_search_credential, index_path

log = logging.getLogger("knowledge.ingest")

UPLOAD_BATCH_SIZE = 100


def write_local_index(docs: list[SearchDocument], library_version: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"library_version": library_version, "built_at": datetime.now(UTC).isoformat(),
               "documents": [d.model_dump(mode="json") for d in docs]}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)  # atomic swap so a running service never reads a half-written index


def _index_definition(name: str):  # type: ignore[no-untyped-def]
    from azure.search.documents.indexes.models import (
        SearchableField,
        SearchFieldDataType,
        SearchIndex,
        SemanticConfiguration,
        SemanticField,
        SemanticPrioritizedFields,
        SemanticSearch,
        SimpleField,
    )

    strings = SearchFieldDataType.Collection(SearchFieldDataType.String)
    fields = [
        SimpleField(name="id", type=SearchFieldDataType.String, key=True),
        SimpleField(name="kind", type=SearchFieldDataType.String, filterable=True, facetable=True),
        SimpleField(name="code", type=SearchFieldDataType.String, filterable=True),
        SearchableField(name="title", type=SearchFieldDataType.String, analyzer_name="en.microsoft"),
        SearchableField(name="content", type=SearchFieldDataType.String, analyzer_name="en.microsoft"),
        SimpleField(name="category", type=SearchFieldDataType.String, filterable=True, facetable=True),
        SimpleField(name="severity", type=SearchFieldDataType.String, filterable=True, facetable=True),
        SimpleField(name="control_type", type=SearchFieldDataType.String, filterable=True, facetable=True),
        SearchableField(name="keywords", type=strings, collection=True, analyzer_name="en.microsoft"),
        SimpleField(name="hazard_codes", type=strings, filterable=True),
    ]
    semantic = SemanticSearch(configurations=[SemanticConfiguration(
        name="default",
        prioritized_fields=SemanticPrioritizedFields(
            title_field=SemanticField(field_name="title"),
            content_fields=[SemanticField(field_name="content")],
            keywords_fields=[SemanticField(field_name="keywords")],
        ),
    )])
    return SearchIndex(name=name, fields=fields, semantic_search=semantic)


async def push_to_azure(docs: list[SearchDocument], settings: Settings, index_name: str) -> int:
    from azure.search.documents.aio import SearchClient
    from azure.search.documents.indexes.aio import SearchIndexClient

    if not settings.search_endpoint or Settings.is_dummy(settings.search_endpoint):
        raise SystemExit("SEARCH_ENDPOINT is not configured; cannot ingest into Azure AI Search")
    credential = azure_search_credential(settings, aio=True)
    uploaded = 0
    try:
        async with SearchIndexClient(settings.search_endpoint, credential) as index_client:
            await index_client.create_or_update_index(_index_definition(index_name))
            log.info("azure_index_ready", extra={"index": index_name})
        async with SearchClient(settings.search_endpoint, index_name, credential) as client:
            records = [d.model_dump(mode="json") for d in docs]
            for start in range(0, len(records), UPLOAD_BATCH_SIZE):
                batch = records[start:start + UPLOAD_BATCH_SIZE]
                results = await client.merge_or_upload_documents(documents=batch)
                failed = [r.key for r in results if not r.succeeded]
                if failed:
                    raise RuntimeError(f"Upload failed for {len(failed)} documents, e.g. {failed[:5]}")
                uploaded += len(batch)
                log.info("azure_batch_uploaded", extra={"count": len(batch), "total": uploaded})
    finally:
        close = getattr(credential, "close", None)
        if close is not None:
            await close()
    return uploaded


def main(argv: list[str] | None = None) -> int:
    settings = get_settings()
    parser = argparse.ArgumentParser(prog="python -m knowledge.ingest", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=Path("knowledge/sources"),
                        help="Directory containing hazard_library.yaml and docs/")
    parser.add_argument("--index", default=settings.search_index, help="Azure AI Search index name")
    parser.add_argument("--target", choices=["local", "azure"], default=settings.provider("search").value)
    parser.add_argument("--validate-only", action="store_true", help="Validate the sources and exit")
    args = parser.parse_args(argv)
    configure_logging("ingest", settings.log_level, settings.log_format)

    try:
        library = load_and_validate(args.source.resolve())
    except LibraryValidationError as exc:
        print(f"Library validation failed ({len(exc.errors)} problem(s)):", file=sys.stderr)
        for err in exc.errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    docs = build_documents(library, args.source.resolve())
    counts: dict[str, int] = {}
    for d in docs:
        counts[d.kind] = counts.get(d.kind, 0) + 1
    log.info("library_valid", extra={"version": library.version, "records": counts})
    if args.validate_only:
        print(f"OK: library {library.version} is valid ({counts})")
        return 0

    if args.target == "azure":
        uploaded = asyncio.run(push_to_azure(docs, settings, args.index))
        print(f"Uploaded {uploaded} records to Azure AI Search index '{args.index}'")
    else:
        path = index_path(settings)
        write_local_index(docs, library.version, path)
        print(f"Wrote {len(docs)} records to {path} ({counts})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
