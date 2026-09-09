// pact-bridge tests: unit tests for the fact mapper plus the end-to-end
// Gladstone competing-hypotheses demo against a locally spawned reference
// server (reference-server/dist/server.js).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createValidators } from "@pact-tailor/ontology";
import {
  toFactProposal,
  fromProposalOutcome,
  buildGladstoneHypotheses,
  runGladstoneDemo,
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const refServerDir = path.resolve(here, "../../../../reference-server");
const serverJs = path.join(refServerDir, "dist", "server.js");

// ---------------------------------------------------------------------------
// Unit: toFactProposal
// ---------------------------------------------------------------------------

test("toFactProposal: sectionId follows the fact field grammar claim:{id}", () => {
  const { metCoal } = buildGladstoneHypotheses();
  const fact = toFactProposal(metCoal);
  assert.equal(fact.sectionId, `claim:${metCoal.inference_id}`);
  assert.match(fact.sectionId, /^claim:infer:[0-9]{4}-[0-9]{2}-[0-9]{2}:[a-z0-9][a-z0-9-]*$/);
});

test("toFactProposal: evidence union keeps every item and its role", () => {
  const { thermal } = buildGladstoneHypotheses();
  const fact = toFactProposal(thermal);

  // union = evidence ∪ contrary_evidence, verbatim, supports first.
  assert.deepEqual(fact.payload.evidence, [
    ...thermal.evidence,
    ...thermal.contrary_evidence,
  ]);
  assert.equal(
    fact.payload.evidence.length,
    thermal.evidence.length + thermal.contrary_evidence.length,
  );
  for (const item of fact.payload.evidence) {
    assert.ok(
      item.role === "supports" || item.role === "contradicts",
      `evidence item lost its role: ${JSON.stringify(item)}`,
    );
  }
  // contrary evidence survives the degradation with role intact.
  assert.ok(
    fact.payload.evidence.some((e) => e.role === "contradicts"),
    "contrary evidence must survive the fact mapping",
  );
  // rest of the payload is the total RFC §3 mapping.
  assert.equal(fact.payload.claim, thermal.claim);
  assert.equal(fact.payload.tier, thermal.tier);
  assert.deepEqual(fact.payload.sources, thermal.sources);
  // summary = claim sentence + confidence.
  assert.ok(fact.summary.includes(thermal.claim), "summary carries the claim sentence");
  assert.ok(fact.summary.includes(String(thermal.confidence)), "summary carries the confidence");
});

test("toFactProposal: no contrary_evidence → union is just the supports array", () => {
  const { metCoal } = buildGladstoneHypotheses();
  const noContrary = structuredClone(metCoal);
  delete noContrary.contrary_evidence;
  const fact = toFactProposal(noContrary);
  assert.deepEqual(fact.payload.evidence, noContrary.evidence);
});

// ---------------------------------------------------------------------------
// Unit: fromProposalOutcome
// ---------------------------------------------------------------------------

test("fromProposalOutcome: returns a NEW record; the original is untouched", () => {
  const { metCoal } = buildGladstoneHypotheses();
  const before = structuredClone(metCoal);

  const next = fromProposalOutcome(metCoal, "approved", {
    fabric_id: "fab-test",
    proposal_id: "prop-test",
  });

  // New object, deep-copied arrays.
  assert.notEqual(next, metCoal);
  assert.notEqual(next.evidence, metCoal.evidence);
  assert.notEqual(next.contrary_evidence, metCoal.contrary_evidence);
  // Original untouched — append-only stance.
  assert.deepEqual(metCoal, before);
  assert.equal(metCoal.status, "INFERRED");
  assert.equal(metCoal.pact, undefined);
  // New record: status transitioned, pact backref filled, evidence retained.
  assert.equal(next.status, "CORROBORATED");
  assert.deepEqual(next.pact, { fabric_id: "fab-test", proposal_id: "prop-test" });
  assert.deepEqual(next.evidence, metCoal.evidence);
  assert.deepEqual(next.contrary_evidence, metCoal.contrary_evidence);
});

test("fromProposalOutcome: rejected → CONTESTED", () => {
  const { thermal } = buildGladstoneHypotheses();
  const next = fromProposalOutcome(thermal, "rejected", {
    fabric_id: "fab-test",
    proposal_id: "prop-test-2",
  });
  assert.equal(next.status, "CONTESTED");
  assert.equal(thermal.status, "INFERRED");
  assert.deepEqual(next.contrary_evidence, thermal.contrary_evidence);
});

// ---------------------------------------------------------------------------
// e2e: Gladstone demo against a spawned reference server
// ---------------------------------------------------------------------------

function ensureReferenceServerBuilt() {
  if (existsSync(serverJs)) return;
  for (const args of [
    ["ci", "--no-audit", "--no-fund"],
    ["run", "build"],
  ]) {
    const r = spawnSync("npm", args, { cwd: refServerDir, stdio: "inherit" });
    assert.equal(
      r.status,
      0,
      `npm ${args.join(" ")} failed in ${refServerDir} (status ${r.status})`,
    );
  }
  assert.ok(existsSync(serverJs), `reference server build produced no ${serverJs}`);
}

/**
 * Spawn the reference server on an ephemeral port and wait for /healthz.
 * Tries a few random ports in case one is already taken.
 * Returns { child, baseUrl }.
 */
async function startReferenceServer() {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 4300 + Math.floor(Math.random() * 1000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [serverJs, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => (output += String(c)));
    child.stderr.on("data", (c) => (output += String(c)));
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });

    // Poll /healthz for up to 10s.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !exited) {
      try {
        const res = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.status === 200) return { child, baseUrl };
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    child.kill();
    lastError = `port ${port}: exited=${exited} output=${output.slice(0, 300)}`;
  }
  assert.fail(`reference server failed to become healthy: ${lastError}`);
}

test("gladstone demo e2e: competing hypotheses resolve via propose/object", async () => {
  ensureReferenceServerBuilt();
  const { child, baseUrl } = await startReferenceServer();
  try {
    const result = await runGladstoneDemo(baseUrl);
    const { corroborated, contested, fabricStatus } = result;

    // A's met-coal inference won consensus.
    assert.equal(corroborated.status, "CORROBORATED");
    assert.ok(corroborated.pact, "corroborated record must carry the pact backref");
    assert.ok(
      typeof corroborated.pact.proposal_id === "string" &&
        corroborated.pact.proposal_id.length > 0,
      "corroborated.pact.proposal_id must be set",
    );
    assert.match(String(corroborated.pact.fabric_id), /^intel-gladstone-demo-/);

    // B's thermal inference was objected to.
    assert.equal(contested.status, "CONTESTED");
    assert.ok(
      typeof contested.pact?.proposal_id === "string" && contested.pact.proposal_id.length > 0,
      "contested.pact.proposal_id must be set",
    );

    // The contested record retains BOTH its own supporting evidence and its
    // contrary evidence — losing consensus loses nothing epistemic.
    assert.ok(contested.evidence.length >= 1, "contested must retain supports evidence");
    for (const e of contested.evidence) assert.equal(e.role, "supports");
    assert.ok(
      Array.isArray(contested.contrary_evidence) && contested.contrary_evidence.length >= 1,
      "contested must retain contrary_evidence",
    );
    for (const e of contested.contrary_evidence) assert.equal(e.role, "contradicts");
    // The winner keeps its contrary evidence too.
    assert.ok(
      Array.isArray(corroborated.contrary_evidence) &&
        corroborated.contrary_evidence.length >= 1,
      "corroborated must retain contrary_evidence",
    );

    // Both final records are schema-valid inferences.
    const validators = createValidators();
    for (const [label, record] of [
      ["corroborated", corroborated],
      ["contested", contested],
    ]) {
      const v = validators.inference(record);
      assert.ok(
        v.ok,
        `${label} record must be schema-valid: ${v.ok ? "" : v.errors.join("; ")}`,
      );
    }

    // The fabric converged: both proposals resolved, none left open.
    assert.equal(fabricStatus.open_proposals, 0, "fabric must show 0 open proposals");
    assert.equal(fabricStatus.fabric_id, corroborated.pact.fabric_id);
    assert.equal(fabricStatus.members.length, 3, "three agents joined the fabric");
  } finally {
    child.kill();
  }
});
