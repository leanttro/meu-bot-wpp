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
let sockGlobal // Variável para armazenar o socket globalmente e permitir disparos externos

// 🔥 MAP DE SESSÕES POR USUÁRIO (MANTIDO DO ORIGINAL)
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
        printQRInTerminal: true, // Habilitado para você ver o QR no console do Dokploy
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
            console.log('✅ WHATSAPP CONECTADO E API DE DISPARO PRONTA')
            sockGlobal = sock // Armazena a conexão ativa
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // --- LOGICA DO TYPEBOT E ATENDIMENTO (MANTIDA INTEGRALMENTE) ---
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
// ROTA DE DISPARO (ONDE O SEU PYTHON SE CONECTA)
// ==========================================
app.post('/disparar', async (req, res) => {
    try {
        const { number, message } = req.body

        if (!sockGlobal) {
            return res.status(503).json({ error: "O WhatsApp ainda não está conectado no servidor." })
        }

        if (!number || !message) {
            return res.status(400).json({ error: "Número (number) e mensagem (message) são obrigatórios." })
        }

        // Formata o número para o padrão JID do WhatsApp
        const jid = `${number}@s.whatsapp.net`

        // Simula interação humana antes do disparo
        await sockGlobal.sendPresenceUpdate('composing', jid)
        await new Promise(resolve => setTimeout(resolve, 1500))
        
        // Dispara a mensagem
        await sockGlobal.sendMessage(jid, { text: message })

        console.log(`🔥 Mensagem de prospecção enviada para: ${number}`)
        res.status(200).json({ status: "success", message: "Mensagem enviada com sucesso" })

    } catch (error) {
        console.error("Erro interno no disparo:", error)
        res.status(500).json({ error: error.message })
    }
})

// Inicia o Servidor API e a Conexão do WhatsApp
app.listen(3000, () => {
    console.log('🚀 SERVIDOR LEANTTRO RODANDO NA PORTA 3000')
    connectToWhatsApp()
})