import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'

// =====================================================================
// CONFIGURAÇÃO DA API DE DISPARO E WEBSOCKET
// =====================================================================
const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

const httpServer = createServer(app)
const io = new Server(httpServer, { 
    cors: { 
        origin: '*',
        methods: ["GET", "POST"]
    } 
})

const TYPEBOT_URL = process.env.TYPEBOT_URL
let sockGlobal

const sessions = new Map()

async function connectToWhatsApp() {
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Versão do WhatsApp Web: v${version.join('.')}`)

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
            console.log('Conexão fechada. Tentando reconectar:', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP CONECTADO - AGUARDANDO COMANDOS')
            sockGlobal = sock
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        const msg = messages[0]

        const remoteJid = msg.key.remoteJid
        const pushName  = msg.pushName || ''
        const fromMe    = msg.key.fromMe || false

        const text      = msg.message?.conversation
                       || msg.message?.extendedTextMessage?.text
                       || null

        const imageMsg   = msg.message?.imageMessage
        const videoMsg   = msg.message?.videoMessage
        const audioMsg   = msg.message?.audioMessage
        const stickerMsg = msg.message?.stickerMessage

        if (text) {
            io.emit('nova_mensagem', { remoteJid, pushName, text, fromMe })
        } else if (imageMsg) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                const base64 = buffer.toString('base64')
                const mime   = imageMsg.mimetype || 'image/jpeg'
                io.emit('nova_mensagem', {
                    remoteJid, pushName, fromMe,
                    mediaType: 'image',
                    mediaBase64: `data:${mime};base64,${base64}`,
                    caption: imageMsg.caption || ''
                })
            } catch(e) {
                console.error('Erro ao baixar imagem:', e.message)
                io.emit('nova_mensagem', { remoteJid, pushName, fromMe, text: '📷 Imagem (erro ao baixar)' })
            }
        } else if (videoMsg) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                const base64 = buffer.toString('base64')
                const mime   = videoMsg.mimetype || 'video/mp4'
                io.emit('nova_mensagem', {
                    remoteJid, pushName, fromMe,
                    mediaType: 'video',
                    mediaBase64: `data:${mime};base64,${base64}`,
                    caption: videoMsg.caption || ''
                })
            } catch(e) {
                console.error('Erro ao baixar vídeo:', e.message)
                io.emit('nova_mensagem', { remoteJid, pushName, fromMe, text: '🎥 Vídeo (erro ao baixar)' })
            }
        } else if (audioMsg) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage })
                const base64 = buffer.toString('base64')
                const mime   = audioMsg.mimetype || 'audio/ogg; codecs=opus'
                io.emit('nova_mensagem', {
                    remoteJid, pushName, fromMe,
                    mediaType: 'audio',
                    mediaBase64: `data:${mime};base64,${base64}`
                })
            } catch(e) {
                console.error('Erro ao baixar áudio:', e.message)
                io.emit('nova_mensagem', { remoteJid, pushName, fromMe, text: '🎵 Áudio (erro ao baixar)' })
            }
        } else if (stickerMsg) {
            io.emit('nova_mensagem', { remoteJid, pushName, fromMe, text: '🎨 Sticker' })
        }

        if (fromMe) return
        if (!text) return

        try {
            const { data } = await axios.post(TYPEBOT_URL, {
                message: text,
                remoteJid: remoteJid
            })

            if (data.messages && data.messages.length > 0) {
                for (const message of data.messages) {
                    await sock.sendPresenceUpdate('composing', remoteJid)
                    await new Promise(r => setTimeout(r, 800))

                    if (message.type === 'text') {
                        const responseText = message.content.richText
                            .map(n => n.children.map(c => c.text).join(''))
                            .join('\n')
                        await sock.sendMessage(remoteJid, { text: responseText })
                        io.emit('nova_mensagem', { remoteJid, text: responseText, fromMe: true })
                    } 
                    else if (message.type === 'image') {
                        await sock.sendMessage(remoteJid, {
                            image: { url: message.content.url }
                        })
                        io.emit('nova_mensagem', { remoteJid, text: 'Imagem enviada', fromMe: true })
                    }
                    else if (message.type === 'audio') {
                        await sock.sendMessage(remoteJid, {
                            audio: { url: message.content.url },
                            mimetype: 'audio/mp4',
                            ptt: true
                        })
                        io.emit('nova_mensagem', { remoteJid, text: 'Áudio enviado', fromMe: true })
                    }
                }
            }
        } catch (error) {
            console.error('❌ ERRO NA INTEGRAÇÃO COM TYPEBOT:', error.response?.data || error.message)
        }
    })
}

io.on('connection', (socket) => {
    console.log('Interface web conectada no WebSocket')
    
    socket.on('enviar_resposta', async (data) => {
        if (!sockGlobal || !data.jid) return
        try {
            if (data.mediaBase64) {
                // extrai o buffer do base64 (data:image/jpeg;base64,XXXX)
                const matches = data.mediaBase64.match(/^data:([^;]+);base64,(.+)$/)
                if (!matches) return
                const mime   = matches[1]
                const buffer = Buffer.from(matches[2], 'base64')
                const caption = data.caption || ''

                if (data.mediaType === 'video') {
                    await sockGlobal.sendMessage(data.jid, { video: buffer, caption, mimetype: mime })
                } else {
                    await sockGlobal.sendMessage(data.jid, { image: buffer, caption, mimetype: mime })
                }
                io.emit('nova_mensagem', {
                    remoteJid:   data.jid,
                    fromMe:      true,
                    mediaType:   data.mediaType,
                    mediaBase64: data.mediaBase64,
                    caption
                })
            } else if (data.text) {
                await sockGlobal.sendMessage(data.jid, { text: data.text })
                io.emit('nova_mensagem', { remoteJid: data.jid, text: data.text, fromMe: true })
            }
        } catch (err) {
            console.error('Erro ao responder via painel:', err)
        }
    })
})

app.get('/status', (req, res) => {
    if (sockGlobal && sockGlobal.user) {
        res.json({ connected: true, number: sockGlobal.user.id.split(':')[0] })
    } else {
        res.json({ connected: false, number: "" })
    }
})

app.post('/disparar', async (req, res) => {
    try {
        const { number, message, image, videoUrl } = req.body

        if (!sockGlobal) {
            return res.status(503).json({ error: "O WhatsApp ainda não está conectado no servidor." })
        }

        if (!number || !message) {
            return res.status(400).json({ error: "Número e mensagem são obrigatórios." })
        }

        const jid = `${number}@s.whatsapp.net`

        await sockGlobal.sendPresenceUpdate('composing', jid)
        await new Promise(r => setTimeout(r, 1500))
        
        if (videoUrl) {
            await sockGlobal.sendMessage(jid, { video: { url: videoUrl }, caption: message })
        } else if (image) {
            const buffer = Buffer.from(image, 'base64')
            await sockGlobal.sendMessage(jid, { image: buffer, caption: message })
        } else {
            await sockGlobal.sendMessage(jid, { text: message })
        }

        io.emit('nova_mensagem', { remoteJid: jid, text: message, fromMe: true })

        console.log(`🚀 Mensagem enviada via API para: ${number}`)
        res.status(200).json({ status: "success", message: "Disparo efetuado" })

    } catch (error) {
        console.error("Falha no disparo via API:", error)
        res.status(500).json({ error: error.message })
    }
})

httpServer.listen(3000, () => {
    console.log('🚀 SERVIDOR LEANTTRO RODANDO NA PORTA 3000 COM WEBSOCKET')
    connectToWhatsApp()
})
