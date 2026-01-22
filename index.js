import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'

// Pega a URL definida no Dokploy. Se não tiver, avisa no log.
const TYPEBOT_URL = process.env.TYPEBOT_URL

if (!TYPEBOT_URL) {
    console.error("❌ ERRO: A variável de ambiente TYPEBOT_URL não foi definida no Dokploy!")
    process.exit(1)
}

async function connectToWhatsApp() {
    // Salva a sessão na pasta 'auth_info' para não pedir QR toda vez
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        defaultQueryTimeoutMs: undefined
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if(qr) {
            console.log('\n👇 ESCANEIE O QR CODE ABAIXO NO LOG DO DOKPLOY 👇\n')
            qrcode.generate(qr, { small: true }) 
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true
            
            console.log(`Conexão caiu. Reconectando: ${shouldReconnect}`)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('✅ CONECTADO! Seu bot está rodando.')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // Escuta as mensagens
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return

        const remoteJid = msg.key.remoteJid
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text

        if (!textMessage) return

        // console.log(`Recebido de ${remoteJid}: ${textMessage}`) // Descomente para debug

        try {
            // Envia para o seu Typebot
            const { data } = await axios.post(TYPEBOT_URL, {
                message: textMessage,
                sessionId: remoteJid
            })

            // Devolve a resposta para o WhatsApp
            if (data.messages && data.messages.length > 0) {
                for (const message of data.messages) {
                    await sock.sendPresenceUpdate('composing', remoteJid)
                    
                    if (message.type === 'text') {
                        // Limpa o texto vindo do Typebot
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
        } catch (error) {
            console.error('Erro ao conectar com Typebot:', error.message)
        }
    })
}

connectToWhatsApp()