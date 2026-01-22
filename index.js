import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

const TYPEBOT_URL = process.env.TYPEBOT_URL

async function connectToWhatsApp() {
    // MUDEI AQUI: _v3 para forçar uma limpeza total da sessão anterior
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_v3')
    
    const sock = makeWASocket({
        auth: state,
        // MUDEI AQUI: De 'silent' para 'error' para vermos se tem erro grave
        logger: pino({ level: 'error' }), 
        printQRInTerminal: false,
        // MUDEI AQUI: Usando uma assinatura de navegador mais padrão para evitar bloqueio
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        connectTimeoutMs: 60000, // Aumentei o tempo para evitar queda em internet lenta
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if(qr) {
            console.log('\n')
            console.log('👇 ESCANEIE O NOVO QR CODE ABAIXO 👇')
            qrcode.generate(qr, { small: true }) 
            console.log('\n')
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true
            
            // MUDEI AQUI: Mostra o motivo exato do erro no log
            console.log('❌ Conexão caiu. Motivo:', lastDisconnect?.error)
            
            if (shouldReconnect) {
                console.log('🔄 Tentando reconectar...')
                connectToWhatsApp()
            } else {
                console.log('⛔ Você foi desconectado. Apague a pasta auth_info e reinicie.')
            }
        } else if (connection === 'open') {
            console.log('✅ SUCESSO ABSOLUTO! Conectado e rodando.')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        // ... (o resto do código continua igual, só a conexão mudou)
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