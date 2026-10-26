"""CPU screening companion for evaluate-semantic-model.mjs; install laya==0.4.8 separately."""
import argparse
import importlib.metadata
import json
import resource
import time

import laya
import torch

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--model", default="convaiinnovations/laya-multilingual")
parser.add_argument("--revision", default="reviewed")
parser.add_argument("--threads", type=int, default=4)
parser.add_argument("--max-len", type=int)
parser.add_argument("--head-max-len", type=int)
args = parser.parse_args()
torch.set_num_threads(args.threads)
torch.set_num_interop_threads(1)
started = time.perf_counter()
agent = laya.load(args.model, device="cpu", revision=args.revision)
load_seconds = time.perf_counter() - started
metadata = {
    "model": args.model, "revision": laya.PINNED_REVISIONS.get(args.model) if args.revision == "reviewed" else args.revision,
    "packages": {name: importlib.metadata.version(name) for name in ("laya", "torch", "transformers")},
    "threads": args.threads, "loadSeconds": load_seconds,
    "maxLen": args.max_len or agent.cfg.get("max_len"),
    "headMaxLen": args.head_max_len or agent.cfg.get("head_max_len"),
    "latencyScope": "In-process CPU, tokenization and inference; loading and one warmup excluded.",
}
print(json.dumps(metadata), flush=True)
with open(args.input) as source:
    rows = [json.loads(line) for line in source if line.strip()]
overrides = {key: value for key, value in {"max_len": args.max_len, "head_max_len": args.head_max_len}.items() if value is not None}
first = rows[0]["request"]
agent.predict(first["state"], first["questions"], **overrides)
with open(args.output, "w") as output:
    for row in rows:
        start = time.perf_counter()
        try:
            response = agent.predict(row["request"]["state"], row["request"]["questions"], **overrides)
            result = {"id": row["id"], "response": response, "latencyMs": (time.perf_counter() - start) * 1000,
                      "metadata": {**metadata, "peakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}}
        except Exception as error:
            result = {"id": row["id"], "error": type(error).__name__, "metadata": metadata}
        output.write(json.dumps(result) + "\n")
        output.flush()
        print(row["id"], round(result.get("latencyMs", 0)), result.get("error", "ok"), flush=True)
