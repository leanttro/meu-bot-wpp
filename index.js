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
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption

        if (!textMessage) return

        console.log(`\n📩 Mensagem recebida de ${remoteJid}: "${textMessage}"`)

        try {
            if (TYPEBOT_URL) {
                // Separação das URLs para evitar erro de rota no Typebot
                const baseUrl = TYPEBOT_URL.split('/api/v1')[0] + '/api/v1'
                const typebotId = TYPEBOT_URL.split('/typebots/')[1]
                
                let response;
                try {
                    // Para continuar, deve-se usar o endpoint de /sessions/
                    console.log(`🔄 Tentando continuar conversa na sessão: ${remoteJid}`)
                    response = await axios.post(`${baseUrl}/sessions/${remoteJid}/continueChat`, {
                        message: textMessage
                    });
                    console.log(`✅ Sucesso no continueChat (Status: ${response.status})`)
                } catch (e) {
                    // Se a sessão não existir ou der erro, inicia uma nova vinculando o JID como sessionId
                    console.log(`⚠️ Sessão não encontrada ou erro no continue. Tentando iniciar nova...`)
                    console.log(`🚀 Chamando startChat: ${baseUrl}/typebots/${typebotId}/startChat`)
                    response = await axios.post(`${baseUrl}/typebots/${typebotId}/startChat`, {
                        message: textMessage,
                        sessionId: remoteJid,
                        prefilledVariables: {
                            remoteJid: remoteJid,
                            user_message: msg.pushName || "Sem Nome",
                            pushName: msg.pushName || "Sem Nome"
                        }
                    });
                    console.log(`✅ Sucesso no startChat (Status: ${response.status})`)
                }

                const data = response.data;
                console.log(`🤖 Resposta do Typebot processada`)

                // 1. Processa botões (Input Choice) convertendo para Lista Numerada
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
            console.error('❌ ERRO NO AXIOS:', error.response?.data || error.message)
        }
    })
}

connectToWhatsApp()