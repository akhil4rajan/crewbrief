"""Export JSON Schema for every public contract model, for TypeScript clients.

    python -m packages.schemas.export [--out DIR]

Writes ``<Model>.json`` per model plus ``index.json`` to ``packages/schemas/jsonschema/``.
Request models are exported in *validation* mode (what a client may send: defaulted fields
are optional); everything else in *serialization* mode (what a client receives: every field
is present).
"""

from __future__ import annotations

import argparse
import inspect
import json
from pathlib import Path

from pydantic import BaseModel

from packages import schemas

DEFAULT_OUT = Path(__file__).resolve().parent / "jsonschema"
SCHEMA_BASE_URI = "https://crewbrief.dev/schemas/"


def public_models() -> dict[str, type[BaseModel]]:
    models: dict[str, type[BaseModel]] = {}
    for name in sorted(schemas.__all__):
        obj = getattr(schemas, name)
        if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj is not schemas.Model:
            models[name] = obj
    return models


def export(out_dir: Path = DEFAULT_OUT) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    models = public_models()
    written: list[Path] = []
    for name, model in models.items():
        mode = "validation" if name.endswith("Request") else "serialization"
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": f"{SCHEMA_BASE_URI}{name}.json",
                  **model.model_json_schema(mode=mode)}
        path = out_dir / f"{name}.json"
        path.write_text(json.dumps(schema, indent=2, sort_keys=False) + "\n", encoding="utf-8")
        written.append(path)
    index = {"form_schema_version": schemas.FORM_SCHEMA_VERSION, "models": sorted(models)}
    (out_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    # Drop schemas of models that no longer exist, so clients never generate stale types.
    keep = {p.name for p in written} | {"index.json"}
    for stale in out_dir.glob("*.json"):
        if stale.name not in keep:
            stale.unlink()
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    args = parser.parse_args()
    written = export(args.out)
    print(f"Wrote {len(written)} schemas to {args.out}")


if __name__ == "__main__":
    main()
