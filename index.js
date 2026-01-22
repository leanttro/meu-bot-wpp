import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

const TYPEBOT_URL = process.env.TYPEBOT_URL

async function connectToWhatsApp() {
    // 1. Busca a versão mais recente do WhatsApp Web automaticamente
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`A versão do WhatsApp Web é: v${version.join('.')}, é a mais recente? ${isLatest}`)

    // 2. Cria uma sessão nova (V4)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_v4')
    
    const sock = makeWASocket({
        version, // <--- O PULO DO GATO: Envia a versão correta
        auth: state,
        logger: pino({ level: 'silent' }), // Silencioso para não poluir
        printQRInTerminal: false,
        // Usar Linux/Chrome é o padrão mais aceito em servidores VPS
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        generateHighQualityLinkPreview: true,
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if(qr) {
            console.log('\n')
            console.log('👇 ESCANEIE O QR CODE ABAIXO 👇')
            qrcode.generate(qr, { small: true }) 
            console.log('\n')
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true
            
            console.log('❌ Conexão caiu. Motivo:', lastDisconnect?.error?.output?.payload || lastDisconnect?.error)
            
            // Se o erro for 405 ou 403, as vezes precisa esperar um pouco
            if (shouldReconnect) {
                console.log('🔄 Reconectando em 5 segundos...')
                setTimeout(connectToWhatsApp, 5000)
            }
        } else if (connection === 'open') {
            console.log('✅ CONEXÃO ESTABELECIDA COM SUCESSO!')
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
            // console.error('Erro Typebot')
        }
    })
}

connectToWhatsApp()