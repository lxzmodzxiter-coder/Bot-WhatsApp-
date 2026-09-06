import "dotenv/config";
import express from "express";
import cors from "cors";
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "node:fs/promises";

const app = express();
const port = Number(process.env.PORT || 3000);
const authDir = process.env.AUTH_DIR || "auth_info_baileys";
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const groupConfig = new Map();
const warnings = new Map();
let sock;
let connectionState = "disconnected";
let lastError = null;
let reconnecting = false;

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").map(value => value.trim()) || true }));
app.use(express.json({ limit: "32kb" }));

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function normalizePhone(value) {
  return String(value || "").replace(/\\D/g, "");
}

function getConfig(jid) {
  return groupConfig.get(jid) || { enabled: false, antilink: false, antiflood: false, adminOnly: true };
}

async function listGroups() {
  if (!sock || connectionState !== "connected") return [];
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map(group => ({
    jid: group.id,
    name: group.subject,
    members: group.participants?.length || 0,
    config: getConfig(group.id),
  }));
}

async function isAdmin(jid, participant) {
  const metadata = await sock.groupMetadata(jid);
  const member = metadata.participants.find(item => jidNormalizedUser(item.id) === jidNormalizedUser(participant));
  return Boolean(member?.admin);
}

async function handleCommand(message, text, groupJid) {
  const command = text.trim().split(/\\s+/)[0].toLowerCase();
  const config = getConfig(groupJid);
  if (!config.enabled) return;
  const sender = message.key.participant || message.key.remoteJid;
  if (config.adminOnly && !(await isAdmin(groupJid, sender))) return;
  const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const target = mentions[0];
  const reply = value => sock.sendMessage(groupJid, { text: value }, { quoted: message });

  if (command === "/bot") {
    const on = text.toLowerCase().includes(" on");
    groupConfig.set(groupJid, { ...config, enabled: on });
    return reply(on ? "✅ LXZ MODZ activado en este grupo." : "⏸️ LXZ MODZ desactivado en este grupo.");
  }
  if (command === "/menu" || command === "/cmd") return reply("🛡️ LXZ MODZ\\n\\n/bot on | /bot off\\n/menu | /cmd | /status\\n/ban @usuario | /kick @usuario\\n/warn @usuario | /warnings @usuario | /resetwarn @usuario\\n/mute @usuario | /antilink on | /antilink off\\n/antiflood on | /antiflood off\\n/botadmin on | /botadmin off\\n/rules");
  if (command === "/status") return reply(`🤖 Estado: ${connectionState}\\n🛡️ Grupo: ${config.enabled ? "activo" : "apagado"}`);
  if (command === "/antilink") {
    const on = text.toLowerCase().includes(" on");
    groupConfig.set(groupJid, { ...config, antilink: on });
    return reply(on ? "🔗 Anti-link activado." : "🔗 Anti-link desactivado.");
  }
  if (command === "/antiflood") {
    const on = text.toLowerCase().includes(" on");
    groupConfig.set(groupJid, { ...config, antiflood: on });
    return reply(on ? "⚡ Anti-flood activado." : "⚡ Anti-flood desactivado.");
  }
  if (["/ban", "/kick"].includes(command) && target) {
    await sock.groupParticipantsUpdate(groupJid, [target], "remove");
    return reply(`🚫 Usuario expulsado: @${target.split("@")[0]}`);
  }
  if (command === "/warn" && target) {
    const key = `${groupJid}:${target}`;
    const count = (warnings.get(key) || 0) + 1;
    warnings.set(key, count);
    return reply(`⚠️ Advertencia ${count}/3 para @${target.split("@")[0]}`);
  }
  if (command === "/warnings" && target) return reply(`⚠️ Advertencias: ${warnings.get(`${groupJid}:${target}`) || 0}`);
  if (command === "/resetwarn" && target) {
    warnings.delete(`${groupJid}:${target}`);
    return reply("✅ Advertencias reiniciadas.");
  }
  if (command === "/rules") return reply("📋 Reglas del grupo: respeta a los demás, no envíes enlaces no autorizados y evita el spam.");
}

async function onMessages(messages) {
  for (const message of messages) {
    const jid = message.key.remoteJid;
    if (!jid?.endsWith("@g.us") || !message.message || message.key.fromMe) continue;
    const text = message.message.conversation || message.message.extendedTextMessage?.text || "";
    const config = getConfig(jid);
    if (config.enabled && config.antilink && /https?:\/\/|www\./i.test(text)) {
      try {
        await sock.sendMessage(jid, { delete: message.key });
        await sock.sendMessage(jid, { text: "🔗 Enlace eliminado por Anti-link." });
      } catch (error) { logger.warn({ error }, "Could not delete link message"); }
    }
    if (text.startsWith("/")) {
      try { await handleCommand(message, text, jid); } catch (error) { logger.warn({ error }, "Command failed"); }
    }
  }
}

async function connect(phoneNumber) {
  if (sock && connectionState === "connected") return sock;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ auth: state, version, printQRInTerminal: false, logger });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", ({ messages }) => onMessages(messages));
  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    connectionState = connection === "open" ? "connected" : connection || connectionState;
    if (connection === "open") { lastError = null; reconnecting = false; }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = code === DisconnectReason.loggedOut ? "logged_out" : "disconnected";
      if (connectionState === "disconnected" && !reconnecting) {
        reconnecting = true;
        setTimeout(() => connect().catch(error => { lastError = error.message; reconnecting = false; }), 3000);
      }
    }
  });
  if (!state.creds.registered && phoneNumber) {
    // Baileys necesita unos segundos para abrir el transporte antes de pedir el código.
    await new Promise(resolve => setTimeout(resolve, 5000));
    const code = await sock.requestPairingCode(phoneNumber);
    return code;
  }
  return null;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "lxz-modz-whatsapp-bot", connection: connectionState, lastError }));
app.get("/api/whatsapp/status", (_req, res) => res.json({ ok: true, connection: connectionState, connected: connectionState === "connected", lastError }));
app.post("/api/whatsapp/pairing-code", async (req, res) => {
  const phoneNumber = normalizePhone(req.body?.phoneNumber);
  if (phoneNumber.length < 8) return jsonError(res, 400, "phoneNumber debe incluir el código de país sin +, espacios ni guiones");
  try {
    const code = await connect(phoneNumber);
    if (!code) return res.status(409).json({ ok: false, error: "La sesión ya está registrada o hay una conexión en curso", connection: connectionState });
    return res.json({ ok: true, code, phoneNumber, connection: connectionState });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return jsonError(res, 500, `WhatsApp rechazó la solicitud: ${lastError}`);
  }
});
app.get("/api/whatsapp/groups", async (_req, res) => {
  try { return res.json({ ok: true, groups: await listGroups(), syncing: connectionState !== "connected" }); }
  catch (error) { return jsonError(res, 500, error.message); }
});
app.post("/api/whatsapp/groups/:jid/config", (req, res) => {
  const current = getConfig(req.params.jid);
  const next = { ...current, ...req.body };
  groupConfig.set(req.params.jid, next);
  return res.json({ ok: true, jid: req.params.jid, config: next });
});
app.post("/api/whatsapp/logout", async (_req, res) => {
  try { if (sock) await sock.logout(); } catch { /* session may already be closed */ }
  sock = undefined; connectionState = "logged_out";
  await fs.rm(authDir, { recursive: true, force: true });
  return res.json({ ok: true });
});

app.listen(port, "0.0.0.0", () => logger.info({ port }, "LXZ MODZ bot API listening"));
