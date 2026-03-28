#!/usr/bin/env node
/**
 * Generate GPS demo GIF from mockup HTML using Puppeteer
 * Usage: node scripts/generate-gps-gif.js
 */
const MOD = '/tmp/gps-gif-gen/node_modules/';
const puppeteer = require(MOD + 'puppeteer');
const GIFEncoder = require(MOD + 'gif-encoder-2');
const { PNG } = require(MOD + 'pngjs');
const fs = require('fs');
const path = require('path');

const MOCKUP = path.join(__dirname, '..', 'backend', 'public', 'assets', 'mockup-gps-location.html');
const OUTPUT = path.join(__dirname, '..', 'backend', 'public', 'assets', 'eclaw-gps-location-demo.gif');

const PHONE_W = 380; // CSS px (matches mockup .phone width)
const PHONE_H = 520; // CSS px — fixed phone height

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: PHONE_W + 40, height: PHONE_H + 40, deviceScaleFactor: 2 });
  await page.goto(`file://${MOCKUP}`, { waitUntil: 'networkidle0' });

  // Fix phone height and make chat scroll
  await page.evaluate((h) => {
    document.querySelector('body').style.margin = '0';
    document.querySelector('body').style.padding = '0';
    const phone = document.querySelector('.phone');
    phone.style.margin = '0';
    phone.style.height = h + 'px';
    phone.style.overflow = 'hidden';
    const chat = document.querySelector('.chat');
    chat.style.minHeight = '0';
    chat.style.height = (h - 62) + 'px'; // subtract header
    chat.style.overflowY = 'auto';
  }, PHONE_H);

  const phone = await page.$('.phone');
  const frames = [];

  async function captureFrame(frameNum, delayMs) {
    if (frameNum > 1) {
      await page.evaluate((n) => showFrame(n), frameNum);
    }
    // Scroll chat to bottom
    await page.evaluate(() => {
      const chat = document.querySelector('.chat');
      chat.scrollTop = chat.scrollHeight;
    });
    await delay(250);
    console.log(`Capturing frame ${frameNum}...`);
    frames.push({ buf: await phone.screenshot({ type: 'png' }), delay: delayMs });
  }

  await captureFrame(1, 1500);
  await captureFrame(2, 1200);
  await captureFrame(3, 1500);
  await captureFrame(4, 2000);
  await captureFrame(5, 3000);

  await browser.close();

  // Encode GIF
  console.log('Encoding GIF...');
  const firstPng = PNG.sync.read(Buffer.from(frames[0].buf));
  const w = firstPng.width;
  const h = firstPng.height;
  console.log(`Frame dimensions: ${w}x${h}`);

  const encoder = new GIFEncoder(w, h, 'neuquant', false);
  encoder.setRepeat(0);
  encoder.setQuality(10);
  encoder.start();

  for (let i = 0; i < frames.length; i++) {
    const png = PNG.sync.read(Buffer.from(frames[i].buf));
    encoder.setDelay(frames[i].delay);
    encoder.addFrame(png.data);
    console.log(`  Added frame ${i + 1}/${frames.length}`);
  }

  encoder.finish();

  const gifBuffer = encoder.out.getData();
  fs.writeFileSync(OUTPUT, gifBuffer);
  console.log(`\nGIF saved: ${OUTPUT} (${(gifBuffer.length / 1024).toFixed(0)} KB)`);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error(err);
  process.exit(1);
});
