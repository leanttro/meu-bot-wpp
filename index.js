import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import express from 'express'
import cors from 'cors'

// =====================================================================
// CONFIGURAÇÃO DA API DE DISPARO (PARA O BUSCADOR PYTHON)
// =====================================================================
const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' })) // Aumentado para suportar imagens em base64

const TYPEBOT_URL = process.env.TYPEBOT_URL
let sockGlobal // Variável para o disparo usar a conexão ativa do bot

// 🔥 MAP DE SESSÕES POR USUÁRIO (MANTIDO INTEGRALMENTE)
const sessions = new Map()

async function connectToWhatsApp() {
    // 1. Garante a versão mais recente para evitar erro 405
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Versão do WhatsApp Web: v${version.join('.')}`)

    // 2. Pasta de sessão definitiva (Volume configurado no Dokploy)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_final')
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        generateHighQualityLinkPreview: true,
        syncFullHistory: false
    })

    // GERENCIAMENTO DE CONEXÃO
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            console.log('\n👇 ESCANEIE O QR CODE NOVO ABAIXO 👇')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexão fechada. Tentando reconectar:', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP CONECTADO - AGUARDANDO COMANDOS')
            sockGlobal = sock // Libera a conexão para a rota /disparar
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // --- LÓGICA DE MENSAGENS E TYPEBOT (COMPLETA E SEM CORTES) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        const msg = messages[0]

        // Não responde se a mensagem for enviada por você mesmo
        if (msg.key.fromMe) return
        
        const remoteJid = msg.key.remoteJid
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
        
        if (!text) return

        try {
            // Envia para o seu Typebot
            const { data } = await axios.post(TYPEBOT_URL, {
                message: text,
                remoteJid: remoteJid
            })

            // Processa as Mensagens (Texto, Imagem, Áudio PTT) vindas do Typebot
            if (data.messages && data.messages.length > 0) {
                for (const message of data.messages) {
                    // Efeito de "digitando..."
                    await sock.sendPresenceUpdate('composing', remoteJid)
                    await new Promise(r => setTimeout(r, 800))

                    if (message.type === 'text') {
                        const responseText = message.content.richText
                            .map(n => n.children.map(c => c.text).join(''))
                            .join('\n')
                        await sock.sendMessage(remoteJid, { text: responseText })
                    } 
                    else if (message.type === 'image') {
                        await sock.sendMessage(remoteJid, {
                            image: { url: message.content.url }
                        })
                    }
                    else if (message.type === 'audio') {
                        await sock.sendMessage(remoteJid, {
                            audio: { url: message.content.url },
                            mimetype: 'audio/mp4',
                            ptt: true
                        })
                    }
                }
            }
        } catch (error) {
            console.error('❌ ERRO NA INTEGRAÇÃO COM TYPEBOT:', error.response?.data || error.message)
        }
    })
}

// =====================================================================
// ROTA DE DISPARO (AQUI O SEU PYTHON SE CONECTA)
// =====================================================================
app.post('/disparar', async (req, res) => {
    try {
        const { number, message, image } = req.body

        if (!sockGlobal) {
            return res.status(503).json({ error: "O WhatsApp ainda não está conectado no servidor." })
        }

        if (!number || !message) {
            return res.status(400).json({ error: "Número (number) e mensagem (message) são obrigatórios." })
        }

        // Formata o número para o padrão JID do WhatsApp
        const jid = `${number}@s.whatsapp.net`

        // Simulação de presença humana (digitando) para evitar ban imediato
        await sockGlobal.sendPresenceUpdate('composing', jid)
        await new Promise(r => setTimeout(r, 1500))
        
        // Envio real da mensagem de prospecção do Sniper (com ou sem imagem)
        if (image) {
            const buffer = Buffer.from(image, 'base64')
            await sockGlobal.sendMessage(jid, { image: buffer, caption: message })
        } else {
            await sockGlobal.sendMessage(jid, { text: message })
        }

        console.log(`🚀 Mensagem enviada via API para: ${number}`)
        res.status(200).json({ status: "success", message: "Disparo efetuado" })

    } catch (error) {
        console.error("Falha no disparo via API:", error)
        res.status(500).json({ error: error.message })
    }
})

// INICIA O SERVIDOR API NA PORTA 3001 (AJUSTADO PARA NÃO CONFLITAR COM DOKPLOY)
app.listen(3001, () => {
    console.log('🚀 SERVIDOR LEANTTRO RODANDO NA PORTA 3001')
    connectToWhatsApp()
})