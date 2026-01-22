import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

// Pega a URL definida no Dokploy
const TYPEBOT_URL = process.env.TYPEBOT_URL

if (!TYPEBOT_URL) {
    console.log("⚠️ AVISO: TYPEBOT_URL não definida. O bot não responderá, mas conectará.")
}

async function connectToWhatsApp() {
    // Mudei o nome da pasta para forçar uma nova sessão limpa
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_v2')
    
    const sock = makeWASocket({
        auth: state,
        // Isso aqui cala a boca dos logs JSON chatos
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false, // Nós vamos imprimir manualmente
        browser: ["Dokploy", "Chrome", "10.0"], // Identidade do navegador
        syncFullHistory: false // Conecta mais rápido
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if(qr) {
            console.log('\n')
            console.log('👇 ESCANEIE ESTE QR CODE AGORA 👇')
            // small: true é melhor para terminais de log
            qrcode.generate(qr, { small: true }) 
            console.log('\n')
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true
            
            // Log simples para você saber o que houve
            console.log(`Conexão caiu. Reconectando...`)
            
            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === 'open') {
            console.log('✅ SUCESSO! Conectado ao WhatsApp.')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return

        const remoteJid = msg.key.remoteJid
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text

        if (!textMessage) return

        try {
            if (TYPEBOT_URL) {
                const { data } = await axios.post(TYPEBOT_URL, {
                    message: textMessage,
                    sessionId: remoteJid
                })

                if (data.messages && data.messages.length > 0) {
                    for (const message of data.messages) {
                        await sock.sendPresenceUpdate('composing', remoteJid)
                        
                        if (message.type === 'text') {
                            const responseText = message.content.richText.map(n => n.children.map(c => c.text).join('')).join('\n')
                            await sock.sendMessage(remoteJid, { text: responseText })
                        } 
                        else if (message.type === 'image') {
                            await sock.sendMessage(remoteJid, { image: { url: message.content.url } })
                        }
                        else if (message.type === 'audio') {
                            await sock.sendMessage(remoteJid, { audio: { url: message.content.url }, mimetype: 'audio/mp4', ptt: true })
                        }
                    }
                }
            }
        } catch (error) {
            // Ignora erros silenciosamente para não sujar o log, ou dê um console.log simples
            // console.error('Erro Typebot')
        }
    })
}

connectToWhatsApp()