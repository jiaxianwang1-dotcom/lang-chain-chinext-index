import { createKimiCliInvoke } from "./src/agent/stock/prediction/kimi-cli-invoke";

async function test() {
  const invoke = createKimiCliInvoke({
    cliPath: "/Users/liuli/miniconda3/bin/kimi",
    timeoutMs: 120000,
  });
  
  try {
    const result = await invoke("You are a helpful assistant.", "What is 2+2?");
    console.log("SUCCESS:", result.slice(0, 50));
  } catch (e: any) {
    console.log("ERROR:", e.message);
    console.log("CODE:", e.status);
    console.log("STDOUT:", e.stdout ? e.stdout.slice(0, 100) : "none");
    console.log("STDERR:", e.stderr ? e.stderr.slice(0, 100) : "none");
  }
}

test();
