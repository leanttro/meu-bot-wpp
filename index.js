import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

const TYPEBOT_URL = process.env.TYPEBOT_URL

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
        
        if(qr) {
            console.log('\n👇 ESCANEIE O QR CODE NOVO ABAIXO 👇')
            qrcode.generate(qr, { small: true }) 
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true
            
            console.log('❌ Conexão caiu. Reconectando...', lastDisconnect?.error?.message)
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000)
            }
        } else if (connection === 'open') {
            console.log('✅ CONEXÃO ESTABELECIDA!')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return

        const remoteJid = msg.key.remoteJid
        // Limpa o ID para evitar erro 404 na API do Typebot
        const cleanSessionId = remoteJid.split('@')[0]
        
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption

        if (!textMessage) return

        console.log(`\n📩 Mensagem de ${cleanSessionId}: "${textMessage}"`)

        try {
            if (TYPEBOT_URL) {
                let response;
                try {
                    // Tenta continuar a conversa
                    response = await axios.post(`${TYPEBOT_URL}/continueChat`, {
                        message: textMessage,
                        sessionId: cleanSessionId
                    });
                    console.log(`✅ ContinueChat OK`)
                } catch (e) {
                    // Se a sessão não existir (404), inicia nova
                    console.log(`⚠️ Criando nova sessão para: ${cleanSessionId}`)
                    response = await axios.post(`${TYPEBOT_URL}/startChat`, {
                        message: textMessage,
                        sessionId: cleanSessionId,
                        prefilledVariables: {
                            remoteJid: remoteJid,
                            user_message: msg.pushName || "Sem Nome",
                            pushName: msg.pushName || "Sem Nome"
                        }
                    });
                }

                const data = response.data;

                // 1. Processa botões (Input Choice)
                if (data.input && data.input.type === 'choice input') {
                    let optionsText = ''
                    optionsText += '\n📋 *Digite o número da opção:*\n'
                    data.input.items.forEach((item, index) => {
                        optionsText += `\n*${index + 1}.* ${item.content}`
                    })
                    await sock.sendMessage(remoteJid, { text: optionsText })
                }

                // 2. Processa as Mensagens normais
                if (data.messages && data.messages.length > 0) {
                    for (const message of data.messages) {
                        await sock.sendPresenceUpdate('composing', remoteJid)
                        await new Promise(r => setTimeout(r, 800))

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
            console.error('❌ ERRO NO PROCESSO:', error.response?.data || error.message)
        }
    })
}

connectToWhatsApp()