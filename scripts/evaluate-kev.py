"""CPU screening through Kev's actual serving code; install a pinned source checkout separately."""
import argparse
import importlib.metadata
import json
import resource
import time

import torch
from kev.api import SystemOneRequest
from kev.checkpoint import Checkpoint, LoadOptions
from kev.serve import Server

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--model", default="jaredpalmer/kev-0.8b@v1.0")
parser.add_argument("--threads", type=int, default=4)
args = parser.parse_args()
torch.set_num_threads(args.threads)
torch.set_num_interop_threads(1)
start = time.perf_counter()
checkpoint = Checkpoint(args.model)
tokenizer, model = checkpoint.load("cpu", LoadOptions(dtype=torch.float32, backend="torch"))
server = Server(checkpoint, tokenizer, model, "cpu")
metadata = {
    "model": args.model, "checkpointRevision": checkpoint.path.rsplit("/", 1)[-1],
    "base": checkpoint.meta.base, "baseRevision": checkpoint.meta.base_revision,
    "packages": {name: importlib.metadata.version(name) for name in ("torch", "transformers", "peft")},
    "threads": args.threads, "loadSeconds": time.perf_counter() - start,
    "temperature": checkpoint.meta.temperature, "dtype": "fp32",
    "latencyScope": "In-process serving path including tokenization; loading and unrelated warmup excluded.",
}
print(json.dumps(metadata), flush=True)
with open(args.input) as source:
    rows = [json.loads(line) for line in source if line.strip()]
try:
    server.answer(SystemOneRequest(state="A synthetic warmup.", questions={"warmup": {"type": "noul", "instructions": "Is this a warmup?"}}))
    with open(args.output, "w") as output:
        for row in rows:
            start = time.perf_counter()
            try:
                response = server.answer(SystemOneRequest(**row["request"]))
                result = {"id": row["id"], "response": response, "latencyMs": (time.perf_counter() - start) * 1000,
                          "metadata": {**metadata, "peakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}}
            except Exception as error:
                result = {"id": row["id"], "error": type(error).__name__, "metadata": metadata}
            output.write(json.dumps(result) + "\n")
            output.flush()
            print(row["id"], round(result.get("latencyMs", 0)), result.get("error", "ok"), flush=True)
finally:
    server.close()
