require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus 
} = require('@discordjs/voice');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    console.error('❌ Faltan DISCORD_TOKEN o CLIENT_ID en el archivo .env');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const MUSIC_DIR = path.join(__dirname, 'Musica');
const LYRICS_DIR = path.join(__dirname, 'letras');

if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
if (!fs.existsSync(LYRICS_DIR)) fs.mkdirSync(LYRICS_DIR, { recursive: true });

const FALLBACK_DOCS = [
    {
        filename: 'Bronco - Que No Quede Huella.mp3',
        title: 'Bronco - Que No Quede Huella',
        text: 'bronco que no quede huella de ti nada adios amor lagrimas dolor pisadas recuerdo'
    },
    {
        filename: 'Clave 7.mp3',
        title: 'Clave 7',
        text: 'clave siete 7 carretera trocas federales retenes cargamento sonora comandante'
    },
    {
        filename: 'El baile del beeper.mp3',
        title: 'El baile del beeper',
        text: 'el beeper biper pipipi suena mi mensaje llamada tono fiesta baile'
    },
    {
        filename: 'Los Tigres Del Norte - Pedro Y Pablo.mp3',
        title: 'Los Tigres Del Norte - Pedro Y Pablo',
        text: 'los tigres del norte pedro y pablo eran hermanos amigo inseparable frontera mojados'
    }
];

function tokenize(text) {
    if (!text) return [];
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 0);
}

class BooleanRetrievalModel {
    constructor() {
        this.invertedIndex = new Map();
        this.documents = [];
    }

    buildIndex(songFiles) {
        this.invertedIndex.clear();
        this.documents = [];

        songFiles.forEach((file, index) => {
            const baseName = file.replace(/\.mp3$/i, '');
            const txtPath = path.join(LYRICS_DIR, `${baseName}.txt`);
            let content = '';

            if (fs.existsSync(txtPath)) {
                content = fs.readFileSync(txtPath, 'utf-8');
            } else {
                const fallback = FALLBACK_DOCS.find(d => d.filename.toLowerCase() === file.toLowerCase());
                content = fallback ? fallback.text : baseName;
            }

            const docId = index;
            this.documents.push({
                docId,
                title: baseName,
                filename: file,
                filePath: path.join(MUSIC_DIR, file)
            });

            const tokens = new Set(tokenize(content + " " + baseName));
            for (const token of tokens) {
                if (!this.invertedIndex.has(token)) {
                    this.invertedIndex.set(token, new Set());
                }
                this.invertedIndex.get(token).add(docId);
            }
        });
    }

    search(queryStr) {
        const universe = new Set(this.documents.map(d => d.docId));
        const rawTokens = queryStr.trim().split(/\s+/);
        if (rawTokens.length === 0) return [];

        let currentResultSet = null;
        let pendingOp = 'AND';
        let negateNext = false;

        for (let token of rawTokens) {
            const upper = token.toUpperCase();

            if (upper === 'AND' || upper === 'OR') {
                pendingOp = upper;
                continue;
            }

            if (upper === 'NOT') {
                negateNext = true;
                continue;
            }

            const term = tokenize(token)[0];
            if (!term) continue;

            let termPosting = new Set(this.invertedIndex.get(term) || []);

            if (negateNext) {
                termPosting = new Set([...universe].filter(id => !termPosting.has(id)));
                negateNext = false;
            }

            if (currentResultSet === null) {
                currentResultSet = termPosting;
            } else {
                if (pendingOp === 'AND') {
                    currentResultSet = new Set([...currentResultSet].filter(id => termPosting.has(id)));
                } else if (pendingOp === 'OR') {
                    currentResultSet = new Set([...currentResultSet, ...termPosting]);
                }
            }
        }

        if (!currentResultSet) return [];
        return [...currentResultSet].map(id => this.documents[id]);
    }
}

const booleanEngine = new BooleanRetrievalModel();
const queues = new Map();

const commands = [
    new SlashCommandBuilder()
        .setName('iniciar')
        .setDescription('Inicia el reproductor interactivo con motor booleano')
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`🤖 Bot listo: ${client.user.tag}`);
    const rest = new REST({ version: '10', timeout: 30000 }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('✅ Comando /iniciar activo.');
    } catch (error) {
        console.error('Error registrando comandos:', error);
    }
});

function buildControlRow(isPaused = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('btn_stop')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('btn_toggle_pause')
            .setEmoji(isPaused ? '▶️' : '⏸️')
            .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('btn_skip')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('btn_search_modal')
            .setEmoji('🔍')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildPlayerEmbed(title, totalSongs) {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle(`🎶 ${title}`)
        .setDescription(`🔁 **Bucle activo** • ${totalSongs} canción(es) en cola`);
}

async function startTrack(guildId) {
    const serverQueue = queues.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) return;

    const currentSong = serverQueue.songs[0];

    const resource = createAudioResource(currentSong.filePath, {
        inlineVolume: true
    });
    resource.volume.setVolume(0.85);

    serverQueue.player.play(resource);
    serverQueue.isPaused = false;

    const embed = buildPlayerEmbed(currentSong.title, serverQueue.songs.length);
    const buttons = buildControlRow(false);

    if (serverQueue.playerMessage) {
        try {
            await serverQueue.playerMessage.edit({ embeds: [embed], components: [buttons] });
            return;
        } catch (e) {}
    }

    serverQueue.playerMessage = await serverQueue.textChannel.send({ 
        embeds: [embed], 
        components: [buttons] 
    });
}

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName, guildId, member } = interaction;

        if (commandName === 'iniciar') {
            const voiceChannel = member.voice?.channel;
            if (!voiceChannel) {
                return interaction.reply({ 
                    content: '❌ Entra a un canal de voz primero.', 
                    flags: 64 
                });
            }

            const rawFiles = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
            if (rawFiles.length === 0) {
                return interaction.reply({ 
                    content: '⚠️ No hay archivos `.mp3` en la carpeta `Musica`.', 
                    flags: 64 
                });
            }

            booleanEngine.buildIndex(rawFiles);
            await interaction.reply({ content: '▶️ Conectando reproductor...', flags: 64 });

            const existingQueue = queues.get(guildId);
            if (existingQueue?.connection) {
                existingQueue.connection.destroy();
                queues.delete(guildId);
            }

            const songQueue = rawFiles.map(file => ({
                title: file.replace(/\.mp3$/i, ''),
                filePath: path.join(MUSIC_DIR, file),
                filename: file
            }));

            const player = createAudioPlayer();
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });

            player.on('error', error => {
                console.error(`Error en reproductor [${guildId}]:`, error.message);
            });

            connection.on('error', error => {
                console.error(`Error en conexión de voz [${guildId}]:`, error.message);
            });

            connection.subscribe(player);

            const queueConstruct = {
                textChannel: interaction.channel,
                voiceChannel: voiceChannel,
                connection: connection,
                player: player,
                songs: songQueue,
                isPaused: false,
                playerMessage: null
            };

            queues.set(guildId, queueConstruct);

            player.on(AudioPlayerStatus.Idle, () => {
                const currentSession = queues.get(guildId);
                if (!currentSession) return;

                if (currentSession.songs.length > 0) {
                    const playedSong = currentSession.songs.shift();
                    currentSession.songs.push(playedSong);
                    startTrack(guildId);
                }
            });

            startTrack(guildId);
        }
    }

    if (interaction.isButton()) {
        const session = queues.get(interaction.guildId);
        if (!session) {
            return interaction.reply({ content: '❌ Sin reproducción activa.', flags: 64 });
        }

        if (interaction.customId === 'btn_search_modal') {
            const modal = new ModalBuilder()
                .setCustomId('modal_boolean_search')
                .setTitle('Búsqueda Booleana');

            const textInput = new TextInputBuilder()
                .setCustomId('query_input')
                .setLabel('Consulta booleana (AND, OR, NOT):')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: bronco OR norte | huella OR tigres | trocas OR beeper')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(textInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_toggle_pause') {
            if (session.isPaused) {
                session.player.unpause();
                session.isPaused = false;
                return interaction.update({ components: [buildControlRow(false)] });
            } else {
                session.player.pause();
                session.isPaused = true;
                return interaction.update({ components: [buildControlRow(true)] });
            }
        }

        if (interaction.customId === 'btn_skip') {
            await interaction.deferUpdate();
            const current = session.songs.shift();
            session.songs.push(current);
            startTrack(interaction.guildId);
            return;
        }

        if (interaction.customId === 'btn_stop') {
            session.songs = [];
            session.player.stop();
            if (session.connection) session.connection.destroy();
            queues.delete(interaction.guildId);

            return interaction.update({
                content: '⏹️ Reproducción finalizada.',
                embeds: [],
                components: []
            });
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_boolean_search') {
            const session = queues.get(interaction.guildId);
            if (!session) {
                return interaction.reply({ content: '❌ Sin sesión activa.', flags: 64 });
            }

            const rawQuery = interaction.fields.getTextInputValue('query_input');
            const matchedDocs = booleanEngine.search(rawQuery);

            if (matchedDocs.length === 0) {
                return interaction.reply({ 
                    content: `🔍 **Modelo Booleano:** Ninguna pista cumple con: \`${rawQuery}\``, 
                    flags: 64 
                });
            }

            const newQueue = matchedDocs.map(doc => ({
                title: doc.title,
                filePath: doc.filePath,
                filename: doc.filename
            }));

            session.songs = newQueue;

            const titles = newQueue.map(s => `• **${s.title}**`).join('\n');
            await interaction.reply({ 
                content: `🎯 **Cola actualizada con ${newQueue.length} pista(s):**\n${titles}\n*Reproduciendo ahora...*`, 
                flags: 64 
            });

            startTrack(interaction.guildId);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);