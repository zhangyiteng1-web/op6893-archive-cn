/**
 * Small helper to log into 123pan and print the Bearer token.
 * Run this locally (NOT in GitHub Actions) to obtain a token:
 *
 *   PAN123_PHONE=13800138000 PAN123_PASSWORD=yourpass node scripts/get-123pan-token.js
 *
 * Then copy the printed token and add it as a GitHub Secret:
 *   Settings → Secrets and variables → Actions → Secrets → PAN123_TOKEN
 */

const USER_API = "https://user.123pan.cn";

async function main() {
  const phone = process.env.PAN123_PHONE;
  const password = process.env.PAN123_PASSWORD;

  if (!phone || !password) {
    console.error("Usage: PAN123_PHONE=13800138000 PAN123_PASSWORD=yourpass node scripts/get-123pan-token.js");
    process.exit(1);
  }

  console.log(`Logging into 123pan as ${phone}...`);

  const res = await fetch(`${USER_API}/api/user/sign_in`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://yun.123pan.cn",
      Referer: "https://yun.123pan.cn/",
      Platform: "web",
      "App-Version": "3",
    },
    body: JSON.stringify({
      remember: true,
      passport: phone,
      password: password,
    }),
  });

  const json = await res.json();

  if (json.code === 200) {
    console.log("\n✓ Login successful!\n");
    console.log("================================================");
    console.log("  PAN123_TOKEN:");
    console.log(`  ${json.data.token}`);
    console.log("================================================");
    console.log("\nCopy the token above and add it as a GitHub Secret:\n");
    console.log("  Repository → Settings → Secrets and variables →");
    console.log("  Actions → Secrets → New repository secret");
    console.log("  Name:  PAN123_TOKEN");
    console.log("  Value: <paste the token here>\n");
    console.log("Note: The token may expire after a few days.");
    console.log("If it stops working, re-run this script to get a new one.\n");
  } else {
    console.error(`\n✗ Login failed: code=${json.code} message=${json.message || JSON.stringify(json)}`);
    process.exit(1);
  }
}

main();