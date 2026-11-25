require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const { BM25Ranker } = require('./bm25');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
    console.error('❌ Faltan DISCORD_TOKEN o CLIENT_ID en el archivo .env');
    process.exit(1);
}

const MUSIC_DIR = path.join(__dirname, 'Musica');
const LYRICS_DIR = path.join(__dirname, 'letras');

const bm25Ranker = new BM25Ranker(LYRICS_DIR);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const queues = new Map();

function normalizeText(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function loadCatalog() {
    if (!fs.existsSync(MUSIC_DIR)) return [];
    const files = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));

    return files.map(file => {
        const title = path.parse(file).name;
        const filePath = path.join(MUSIC_DIR, file);
        const lyricPath = path.join(LYRICS_DIR, `${title}.txt`);
        let lyrics = '';
        if (fs.existsSync(lyricPath)) {
            lyrics = fs.readFileSync(lyricPath, 'utf8');
        }
        return {
            title,
            filePath,
            searchableText: normalizeText(`${title} ${lyrics}`)
        };
    });
}

function evaluateBooleanQuery(query, text) {
    const tokens = query.trim().split(/\s+/);
    if (tokens.length === 0) return false;

    let result = null;
    let currentOp = 'AND';
    let negateNext = false;

    for (const rawToken of tokens) {
        const upper = rawToken.toUpperCase();
        if (upper === 'AND' || upper === 'OR') {
            currentOp = upper;
            continue;
        }
        if (upper === 'NOT') {
            negateNext = true;
            continue;
        }

        const term = normalizeText(rawToken);
        let match = text.includes(term);
        if (negateNext) {
            match = !match;
            negateNext = false;
        }

        if (result === null) {
            result = match;
        } else if (currentOp === 'AND') {
            result = result && match;
        } else if (currentOp === 'OR') {
            result = result || match;
        }
    }

    return Boolean(result);
}

function buildControlRow(isPaused = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('btn_stop')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('btn_pause_resume')
            .setEmoji(isPaused ? '▶️' : '⏸️')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('btn_skip')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('btn_search_modal')
            .setLabel('Booleana')
            .setEmoji('🔍')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('btn_bm25_modal')
            .setLabel('BM25')
            .setEmoji('📊')
            .setStyle(ButtonStyle.Success)
    );
}

async function startTrack(guildId) {
    const session = queues.get(guildId);
    if (!session || session.songs.length === 0) return;

    const currentSong = session.songs[0];
    const resource = createAudioResource(currentSong.filePath);
    session.player.play(resource);
    session.isPaused = false;

    const content = `🎶 **${currentSong.title}**\n🔄 Bucle activo • ${session.songs.length} canciones en cola`;
    const row = buildControlRow(false);

    try {
        if (session.playerMessage) {
            await session.playerMessage.edit({ content, components: [row] });
        } else {
            session.playerMessage = await session.textChannel.send({ content, components: [row] });
        }
    } catch (err) {
        console.error('Error actualizando mensaje del reproductor:', err.message);
    }
}

client.once('clientReady', async () => {
    console.log(`🤖 Bot listo: ${client.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName('iniciar')
            .setDescription('Inicia el reproductor de música con búsqueda booleana y ranking BM25')
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Comando /iniciar activo.');
    } catch (error) {
        console.error('Error registrando comando:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'iniciar') {
            await interaction.deferReply({ flags: 64 });

            const voiceChannel = interaction.member?.voice?.channel;
            if (!voiceChannel) {
                return interaction.editReply('❌ Debes entrar primero a un canal de voz.');
            }

            const catalog = loadCatalog();
            if (catalog.length === 0) {
                return interaction.editReply('❌ No hay archivos `.mp3` en la carpeta `Musica`.');
            }

            bm25Ranker.buildIndex();

            const guildId = interaction.guildId;
            const existing = queues.get(guildId);
            if (existing) {
                existing.player.stop();
                if (existing.connection) existing.connection.destroy();
                queues.delete(guildId);
            }

            const player = createAudioPlayer();
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator
            });

            player.on('error', error => {
                console.error(`Error en reproductor [${guildId}]:`, error.message);
            });

            connection.on('error', error => {
                console.error(`Error en conexión de voz [${guildId}]:`, error.message);
            });

            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
            connection.subscribe(player);

            const queueConstruct = {
                textChannel: interaction.channel,
                voiceChannel: voiceChannel,
                connection: connection,
                player: player,
                songs: [...catalog],
                isPaused: false,
                playerMessage: null
            };

            queues.set(guildId, queueConstruct);

            player.on(AudioPlayerStatus.Idle, () => {
                const currentSession = queues.get(guildId);
                if (!currentSession || currentSession.songs.length === 0) return;

                const playedSong = currentSession.songs.shift();
                currentSession.songs.push(playedSong);
                startTrack(guildId);
            });

            await startTrack(guildId);
            return interaction.editReply('✅ Reproductor iniciado correctamente.');
        }

        if (interaction.isButton()) {
            const session = queues.get(interaction.guildId);
            if (!session) {
                return interaction.reply({ content: '❌ Sin reproducción activa. Usa `/iniciar`.', flags: 64 });
            }

            if (interaction.customId === 'btn_pause_resume') {
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
                await startTrack(interaction.guildId);
                return;
            }

            if (interaction.customId === 'btn_stop') {
                session.songs = [];
                session.player.stop();
                if (session.connection) session.connection.destroy();
                queues.delete(interaction.guildId);

                return interaction.update({
                    content: '⏹️ Reproducción finalizada.',
                    components: []
                });
            }

            if (interaction.customId === 'btn_search_modal') {
                const modal = new ModalBuilder()
                    .setCustomId('modal_boolean_search')
                    .setTitle('Búsqueda Booleana (AND / OR / NOT)');

                const input = new TextInputBuilder()
                    .setCustomId('query_input')
                    .setLabel('Consulta booleana sobre letras y títulos')
                    .setPlaceholder('Ej: amor AND noche NOT dolor')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_bm25_modal') {
                const modal = new ModalBuilder()
                    .setCustomId('modal_bm25_search')
                    .setTitle('Ranking Probabilístico (Okapi BM25)');

                const input = new TextInputBuilder()
                    .setCustomId('bm25_query_input')
                    .setLabel('Palabras clave o frase libre')
                    .setPlaceholder('Ej: corazon roto lluvia recuerdos')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_boolean_search') {
            await interaction.deferReply({ flags: 64 });
            const session = queues.get(interaction.guildId);
            if (!session) {
                return interaction.editReply('❌ Sin sesión activa.');
            }

            const query = interaction.fields.getTextInputValue('query_input');
            const matches = session.songs.filter(song => evaluateBooleanQuery(query, song.searchableText));

            if (matches.length === 0) {
                return interaction.editReply(`🔍 Sin coincidencias booleanas para: **${query}**`);
            }

            const rest = session.songs.filter(song => !matches.includes(song));
            session.songs = [...matches, ...rest];
            await startTrack(interaction.guildId);

            const listText = matches.slice(0, 10).map((s, i) => `${i + 1}. **${s.title}**`).join('\n');
            return interaction.editReply(`✅ **${matches.length}** coincidencias booleanas (reproduciendo la #1):\n${listText}`);
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_bm25_search') {
            await interaction.deferReply({ flags: 64 });
            const session = queues.get(interaction.guildId);
            if (!session) {
                return interaction.editReply('❌ Sin sesión activa.');
            }

            const query = interaction.fields.getTextInputValue('bm25_query_input');
            const ranked = bm25Ranker.search(query, 10);

            if (ranked.length === 0) {
                return interaction.editReply(`📊 Sin documentos relevantes en BM25 para: **${query}**`);
            }

            const rankedMap = new Map(ranked.map((item, idx) => [normalizeText(item.name), idx]));
            const matchedSongs = [];
            const otherSongs = [];

            for (const song of session.songs) {
                if (rankedMap.has(normalizeText(song.title))) {
                    matchedSongs.push(song);
                } else {
                    otherSongs.push(song);
                }
            }

            matchedSongs.sort((a, b) => {
                return rankedMap.get(normalizeText(a.title)) - rankedMap.get(normalizeText(b.title));
            });

            if (matchedSongs.length > 0) {
                session.songs = [...matchedSongs, ...otherSongs];
                await startTrack(interaction.guildId);
            }

            const embed = new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle(`📊 Ranking Probabilístico Okapi BM25`)
                .setDescription(`**Consulta:** \`${query}\`\n*Reproduciendo el resultado #1 con mayor puntuación RSV:*\n\n` +
                    ranked.map((r, i) => `**${i + 1}.** ${r.name} — \`Score RSV: ${r.score}\``).join('\n')
                );

            return interaction.editReply({ embeds: [embed] });
        }
    } catch (err) {
        if (err?.code === 10062) return;
        console.error('Error en interactionCreate:', err);
    }
});

client.on('error', console.error);
process.on('unhandledRejection', (err) => {
    if (err?.code === 10062) return;
    console.error('Unhandled rejection:', err);
});

client.login(TOKEN);
