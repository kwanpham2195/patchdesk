import sharp from "sharp";

await compare(process.argv.slice(2));

async function compare([approved, implemented, output]) {
  if (
    approved === undefined ||
    implemented === undefined ||
    output === undefined
  )
    throw new Error(
      "Usage: node scripts/compare-pr-workbench-overview.mjs <approved> <implemented> <output>",
    );
  const [left, right] = await Promise.all([
    sharp(approved).metadata(),
    sharp(implemented).metadata(),
  ]);
  if (
    left.width === undefined ||
    left.height === undefined ||
    right.width === undefined ||
    right.height === undefined
  )
    throw new Error("Both images need dimensions");
  const labelHeight = 36;
  const width = left.width + right.width;
  const height = Math.max(left.height, right.height) + labelHeight;
  await sharp({ create: { width, height, channels: 4, background: "#101114" } })
    .composite([
      { input: approved, left: 0, top: labelHeight },
      { input: implemented, left: left.width, top: labelHeight },
      {
        input: Buffer.from(
          `<svg width="${width}" height="${labelHeight}"><style>text{font:600 14px sans-serif;fill:#f4f4f5}</style><text x="16" y="23">Approved</text><text x="${left.width + 16}" y="23">Implemented</text></svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toFile(output);
}
