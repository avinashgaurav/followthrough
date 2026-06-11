import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SttError,
  findWhisperBinary,
  modelCandidatePath,
  sttAvailable,
  transcribeAudio,
  type Runner,
  type WhichFn,
} from "./whisper.ts";

const FAKE_FFMPEG = "/fake/bin/ffmpeg";
const FAKE_WHISPER = "/fake/bin/whisper-cli";

const whichAll: WhichFn = (cmd) => (cmd === "ffmpeg" ? FAKE_FFMPEG : FAKE_WHISPER);
const whichFfmpegOnly: WhichFn = (cmd) => (cmd === "ffmpeg" ? FAKE_FFMPEG : null);
const whichNothing: WhichFn = () => null;

let savedBinEnv: string | undefined;
let savedModelEnv: string | undefined;
let scratchDir: string;
let fakeModel: string;

beforeEach(() => {
  savedBinEnv = process.env.WHISPER_CPP_PATH;
  savedModelEnv = process.env.WHISPER_MODEL_PATH;
  delete process.env.WHISPER_CPP_PATH;
  delete process.env.WHISPER_MODEL_PATH;
  scratchDir = mkdtempSync(join(tmpdir(), "ie-stt-test-"));
  fakeModel = join(scratchDir, "ggml-test-model.bin");
  writeFileSync(fakeModel, "not a real model");
});

afterEach(() => {
  if (savedBinEnv === undefined) delete process.env.WHISPER_CPP_PATH;
  else process.env.WHISPER_CPP_PATH = savedBinEnv;
  if (savedModelEnv === undefined) delete process.env.WHISPER_MODEL_PATH;
  else process.env.WHISPER_MODEL_PATH = savedModelEnv;
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Stub runner: records commands; on the whisper call, writes <outBase>.txt. */
function makeStubRunner(transcript = " Hello from whisper. \n"): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === FAKE_WHISPER) {
      const outBase = cmd[cmd.indexOf("-of") + 1]!;
      writeFileSync(`${outBase}.txt`, transcript);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("findWhisperBinary", () => {
  test("prefers WHISPER_CPP_PATH over PATH discovery", () => {
    process.env.WHISPER_CPP_PATH = "/custom/whisper";
    expect(findWhisperBinary(whichAll)).toBe("/custom/whisper");
  });

  test("falls back to known CLI names, null when absent", () => {
    expect(findWhisperBinary(whichAll)).toBe(FAKE_WHISPER);
    expect(findWhisperBinary(whichNothing)).toBeNull();
  });
});

describe("transcribeAudio", () => {
  test("happy path: ffmpeg convert, whisper run, txt read, tmp cleanup", async () => {
    const { runner, calls } = makeStubRunner();
    const text = await transcribeAudio("/uploads/call.webm", {
      runner,
      which: whichAll,
      model: fakeModel,
    });

    expect(text).toBe("Hello from whisper.");
    expect(calls).toHaveLength(2);

    const ff = calls[0]!;
    expect(ff[0]).toBe(FAKE_FFMPEG);
    expect(ff).toContain("/uploads/call.webm");
    expect(ff.join(" ")).toContain("-ar 16000");
    expect(ff.join(" ")).toContain("-ac 1");

    const wav = ff[ff.length - 1]!;
    const wr = calls[1]!;
    expect(wr[0]).toBe(FAKE_WHISPER);
    expect(wr[wr.indexOf("-m") + 1]).toBe(fakeModel);
    expect(wr[wr.indexOf("-f") + 1]).toBe(wav); // whisper consumes the converted wav
    expect(wr).toContain("-otxt");
    expect(wr).toContain("-np");

    // tmp workdir (holds the wav and the txt) is removed
    expect(existsSync(dirname(wav))).toBe(false);
  });

  test("missing ffmpeg: actionable setup error", async () => {
    await expect(transcribeAudio("/a.webm", { which: whichNothing })).rejects.toThrow(
      "ffmpeg not found. Run: bash scripts/setup-whisper.sh",
    );
  });

  test("missing whisper binary: actionable setup error", async () => {
    await expect(
      transcribeAudio("/a.webm", { which: whichFfmpegOnly, model: fakeModel }),
    ).rejects.toThrow(/whisper\.cpp binary not found.*setup-whisper\.sh/);
  });

  test("missing model: actionable setup error naming the path", async () => {
    const gone = join(scratchDir, "missing-model.bin");
    await expect(
      transcribeAudio("/a.webm", { which: whichAll, model: gone }),
    ).rejects.toThrow(new RegExp(`Whisper model not found at ${gone}.*setup-whisper\\.sh`));
  });

  test("ffmpeg failure surfaces stderr and marks SttError", async () => {
    const runner: Runner = async () => ({ exitCode: 1, stdout: "", stderr: "decode boom" });
    await expect(
      transcribeAudio("/a.webm", { runner, which: whichAll, model: fakeModel }),
    ).rejects.toBeInstanceOf(SttError);
    await expect(
      transcribeAudio("/a.webm", { runner, which: whichAll, model: fakeModel }),
    ).rejects.toThrow(/ffmpeg failed.*decode boom/);
  });

  test("whisper failure surfaces stderr", async () => {
    const runner: Runner = async (cmd) =>
      cmd[0] === FAKE_FFMPEG
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 2, stdout: "", stderr: "model load failed" };
    await expect(
      transcribeAudio("/a.webm", { runner, which: whichAll, model: fakeModel }),
    ).rejects.toThrow(/whisper\.cpp failed.*model load failed/);
  });

  test("empty transcript output is an error", async () => {
    const { runner } = makeStubRunner("   \n");
    await expect(
      transcribeAudio("/a.webm", { runner, which: whichAll, model: fakeModel }),
    ).rejects.toThrow(/empty transcript/);
  });
});

describe("sttAvailable", () => {
  test("everything present: ok with no missing entries", () => {
    process.env.WHISPER_MODEL_PATH = fakeModel;
    expect(sttAvailable({ which: whichAll })).toEqual({ ok: true, missing: [] });
  });

  test("everything missing: lists ffmpeg, binary, and model with expected path", () => {
    process.env.WHISPER_MODEL_PATH = join(scratchDir, "nope.bin");
    const res = sttAvailable({ which: whichNothing });
    expect(res.ok).toBe(false);
    expect(res.missing).toContain("ffmpeg");
    expect(res.missing).toContain("whisper.cpp binary");
    expect(res.missing.some((m) => m.includes(modelCandidatePath()))).toBe(true);
  });
});
