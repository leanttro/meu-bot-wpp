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
            console.log('✅ CONEXÃO ESTABELECIDA! Pronto para salvar no Banco.')
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

        try {
            if (TYPEBOT_URL) {
                // AQUI ESTÁ A MÁGICA PARA O SEU BANCO DE DADOS
                const { data } = await axios.post(TYPEBOT_URL, {
                    message: textMessage,
                    sessionId: remoteJid,
                    // Injeta essas variáveis no Typebot automaticamente
                    prefilledVariables: {
                        remoteJid: remoteJid,               // Variável para salvar no Postgres
                        user_message: msg.pushName || "Sem Nome", // Nome do perfil do usuário
                        pushName: msg.pushName || "Sem Nome"
                    }
                })

                // 1. Processa botões (Input Choice) convertendo para Lista Numerada
                if (data.input && data.input.type === 'choice input') {
                    let optionsText = ''
                    // Se a IA mandou texto antes das opções, exibe ele
                    if (data.messages && data.messages.length > 0) {
                         const lastMsg = data.messages[data.messages.length - 1]
                         if (lastMsg.type === 'text') {
                             // Opcional: remover a última mensagem da fila de envio normal para não duplicar, 
                             // mas geralmente deixamos enviar e mandamos a lista em seguida.
                         }
                    }
                    
                    optionsText += '\n📋 *Digite o número da opção:*\n'
                    data.input.items.forEach((item, index) => {
                        optionsText += `\n*${index + 1}.* ${item.content}`
                    })
                    
                    // Envia a lista
                    await sock.sendMessage(remoteJid, { text: optionsText })
                }

                // 2. Processa as Mensagens normais (Texto, Imagem, Áudio)
                if (data.messages && data.messages.length > 0) {
                    for (const message of data.messages) {
                        await sock.sendPresenceUpdate('composing', remoteJid)
                        await new Promise(r => setTimeout(r, 800)) // Delay leve

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
            console.error('Erro no processamento:', error.message)
        }
    })
}

connectToWhatsApp()