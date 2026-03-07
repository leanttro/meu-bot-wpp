import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import express from 'express'
import cors from 'cors'

// --- CONFIGURAÇÃO DA API DE DISPARO ---
const app = express()
app.use(cors())
app.use(express.json())

const TYPEBOT_URL = process.env.TYPEBOT_URL
let sockGlobal // Referência para o disparo via Python

// 🔥 MAP DE SESSÕES POR USUÁRIO
const sessions = new Map()

async function connectToWhatsApp() {
    // 1. Garante a versão mais recente para evitar erro 405
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Versão do WhatsApp Web: v${version.join('.')}`)

    // 2. Pasta de sessão definitiva
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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            console.log('\n👇 ESCANEIE O QR CODE NOVO ABAIXO 👇')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexão fechada devido a:', lastDisconnect.error, ', tentando reconectar:', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP CONECTADO')
            sockGlobal = sock // Atribui o socket para a rota de disparo
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // --- LOGICA DO TYPEBOT (MANTIDA INTEGRALMENTE) ---
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

            // Processa as Mensagens do Typebot
            if (data.messages && data.messages.length > 0) {
                for (const message of data.messages) {
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
            console.error('❌ ERRO NO AXIOS:', error.response?.data || error.message)
        }
    })
}

// ==========================================
// ROTA DE DISPARO (AQUI O SEU PYTHON SE CONECTA)
// ==========================================
app.post('/disparar', async (req, res) => {
    try {
        const { number, message } = req.body

        if (!sockGlobal) {
            return res.status(503).json({ error: "WhatsApp não está conectado ainda." })
        }

        if (!number || !message) {
            return res.status(400).json({ error: "Falta o número ou a mensagem." })
        }

        const jid = `${number}@s.whatsapp.net`

        // Simula digitando
        await sockGlobal.sendPresenceUpdate('composing', jid)
        await new Promise(resolve => setTimeout(resolve, 1500))
        
        // Envia a mensagem
        await sockGlobal.sendMessage(jid, { text: message })

        console.log(`🔥 Disparo enviado para: ${number}`)
        res.status(200).json({ status: "success" })

    } catch (error) {
        console.error("Erro no disparo:", error)
        res.status(500).json({ error: error.message })
    }
})

// Inicia o servidor e a conexão
app.listen(3000, () => {
    console.log('🚀 SERVIDOR DE DISPARO RODANDO NA PORTA 3000')
    connectToWhatsApp()
})