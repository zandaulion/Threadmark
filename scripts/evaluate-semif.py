"""Screen SemIf's GGUF CPU backend, preserving System One questions and recording unsupported choices."""
import argparse
import json
import resource
import time

from semif_phase1 import llamacpp_backend as backend

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--gguf", required=True)
parser.add_argument("--model", default="Qwen/Qwen3.5-4B")
parser.add_argument("--revision", default="851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a")
parser.add_argument("--threads", type=int, default=4)
args = parser.parse_args()
started = time.perf_counter()
model, tokenizer, metadata = backend.load_model(args.model, args.revision, args.gguf, threads=args.threads, context_tokens=4096)
metadata.update(loadSeconds=time.perf_counter() - started,
                latencyScope="In-process shared-state CPU scoring; loading and unrelated warmup excluded.")
print(json.dumps(metadata), flush=True)

def render(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

def questions(request):
    rows, unsupported = [], []
    for key, question in request["questions"].items():
        if question["type"] == "noul":
            criteria = question.get("criteria", {})
            options = [{"id": "false", "description": "No. " + criteria.get("false", "The condition does not hold.")},
                       {"id": "true", "description": "Yes. " + criteria.get("true", "The condition holds.")}]
        else:
            options = [{"id": name, "description": name + (": " + render(description) if description else "")}
                       for name, description in question["criteria"].items()]
        if len(options) > 16:
            unsupported.append({"id": key, "reason": "SemIf reference limit is 16 options", "options": len(options)})
            continue
        rows.append({"id": key, "state": request["state"], "question": render(question["instructions"]), "options": options})
    return rows, unsupported

with open(args.input) as source:
    rows = [json.loads(line) for line in source if line.strip()]
warmup = {"id": "warmup", "state": "Synthetic warmup", "question": "Is this a warmup?",
          "options": [{"id": "false", "description": "No"}, {"id": "true", "description": "Yes"}]}
backend.score_shared(model, tokenizer, [warmup], metadata)
with open(args.output, "w") as output:
    for row in rows:
        start = time.perf_counter()
        try:
            decisions, unsupported = questions(row["request"])
            results, timing = backend.score_shared(model, tokenizer, decisions, metadata)
            answers = {}
            for result in results:
                key = result["id"]
                kind = row["request"]["questions"][key]["type"]
                probabilities = dict(zip(result["option_ids"], result["probabilities"]))
                if kind == "noul":
                    answers[key] = {"type": "noul", "noul": probabilities["true"]}
                else:
                    best = max(probabilities, key=probabilities.get)
                    # This confidence matches Threadmark's current minimum-of-choice use, not a calibration guarantee.
                    count = len(probabilities)
                    confidence = (probabilities[best] - 1 / count) / (1 - 1 / count)
                    answers[key] = {"type": "choice", "choice": best, "confidence": confidence, "probabilities": probabilities}
            result = {"id": row["id"], "response": {"model": args.model, "answers": answers},
                      "latencyMs": (time.perf_counter() - start) * 1000,
                      "metadata": {**metadata, "unsupportedQuestions": unsupported,
                                   "timing": timing, "promptHashes": {r["id"]: r["prompt_sha256"] for r in results},
                                   "peakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}}
        except Exception as error:
            result = {"id": row["id"], "error": type(error).__name__, "metadata": metadata}
            print(str(error), flush=True)
        output.write(json.dumps(result) + "\n")
        output.flush()
        print(row["id"], round(result.get("latencyMs", 0)), result.get("error", "ok"), flush=True)
