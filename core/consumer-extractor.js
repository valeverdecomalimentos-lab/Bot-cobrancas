'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SNAPSHOT_SCHEMA_VERSION = 1;
const SUPPORTED_BACKUP_EXTENSIONS = new Set(['.fbconsumer', '.fb', '.fbk', '.gbk', '.bak', '.backup']);
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_RESTORE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_QUERY_TIMEOUT_MS = 5 * 60 * 1000;

class ConsumerBackupError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'ConsumerBackupError';
        this.code = code;
        if (options.stage) this.stage = options.stage;
        if (options.details) this.details = options.details;
    }
}

const ENTITY_DEFINITIONS = Object.freeze([
    defineEntity('contatos', 'CONTATOS', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'ativo', 'boolean', 'CASE WHEN DATADELETE IS NULL THEN 1 ELSE 0 END'],
        ['DATANASCIMENTO', 'nascimento', 'date'],
        ['LIMITECREDITOCONTACORRENTE', 'limiteCredito', 'number'],
        ['SALDOATUALCONTACORRENTE', 'saldoAtual', 'number'],
        ['DATAINSERT', 'criadoEm', 'date'],
        ['LAT', 'latitude', 'number'],
        ['LON', 'longitude', 'number'],
        ['CIDADE', 'cidade', 'string'],
        ['NOME', 'nome', 'string'],
        ['ENDERECO', 'endereco', 'string'],
        ['BAIRRO', 'bairro', 'string'],
        ['COMPLEMENTO', 'complemento', 'string'],
        ['REFERENCIA', 'referencia', 'string'],
        ['TIPO', 'tipo', 'string'],
        ['CEP', 'cep', 'string'],
        ['NUMERO', 'numero', 'string'],
        ['CNPJOUCPF', 'documento', 'string'],
        ['UF', 'uf', 'string'],
        ['EMAIL', 'email', 'string'],
        ['RGOUIE', 'inscricao', 'string'],
        ['FONEPRINCIPAL', 'telefonePrincipal', 'string'],
        ['FONERECADOS', 'telefoneRecados', 'string'],
        ['FONECELULAR', 'celular', 'string'],
        ['SEXO', 'sexo', 'string'],
        ['BLOQUEARVENDAAPOSLIMITE', 'vendaBloqueadaAposLimite', 'boolean'],
        ['ARQUIVARFIADO', 'fiadoArquivado', 'boolean'],
        ['WHATSAPPID', 'whatsappId', 'string'],
    ]),
    defineEntity('categorias', 'ETIQUETAS', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'ativo', 'boolean', 'CASE WHEN DATADELETE IS NULL THEN 1 ELSE 0 END'],
        ['DESCRICAO', 'descricao', 'string'],
        ['ORDEM', 'ordem', 'integer'],
        ['CODIGOGUID', 'guid', 'string'],
        ['TIPO', 'tipo', 'string'],
    ]),
    defineEntity('produtos', 'PRODUTOS', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['DESCONTINUADO', 'ativo', 'boolean', "CASE WHEN DESCONTINUADO = 'N' THEN 1 ELSE 0 END"],
        ['CODIGOETIQUETA', 'etiquetaId', 'integer'],
        ['PRECOVENDA', 'precoVenda', 'number'],
        ['ESTOQUEMINIMO', 'estoqueMinimo', 'number'],
        ['ESTOQUEATUAL', 'estoqueAtual', 'number'],
        ['PRECOCUSTO', 'precoCusto', 'number'],
        ['CODIGOPRODUTOTIPO', 'tipoProdutoId', 'integer'],
        ['VALIDADEDIAS', 'validadeDias', 'integer'],
        ['ORDEM', 'ordem', 'integer'],
        ['NOME', 'nome', 'string'],
        ['NCM', 'ncm', 'string'],
        ['DESCRICAO', 'descricao', 'string'],
        ['ESTOQUECONTROLADO', 'estoqueControlado', 'boolean'],
        ['DESCONTINUADO', 'descontinuado', 'boolean'],
        ['ITEMPORKG', 'itemPorKg', 'boolean'],
        ['CODIGOPERSONALIZADO', 'codigoPersonalizado', 'string'],
        ['ITEMCOZINHA', 'itemCozinha', 'boolean'],
        ['CODIGOUNIDADECOMERCIAL', 'unidadeComercialId', 'integer'],
        ['CODIGOGUID', 'guid', 'string'],
    ]),
    defineEntity('produtoDetalhes', 'PRODUTODETALHE', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['CODIGOPRODUTO', 'produtoId', 'integer'],
        ['CODIGOPRODUTOTAMANHO', 'tamanhoId', 'integer'],
        ['PRECOCUSTO', 'precoCusto', 'number'],
        ['PRECOVENDA', 'precoVenda', 'number'],
        ['ESTOQUEATUAL', 'estoqueAtual', 'number'],
        ['ESTOQUEMINIMO', 'estoqueMinimo', 'number'],
        ['ESTOQUECONTROLADO', 'estoqueControlado', 'boolean'],
        ['DATAINSERT', 'criadoEm', 'date'],
        ['DATAUPDATE', 'atualizadoEm', 'date'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'ativo', 'boolean', 'CASE WHEN DATADELETE IS NULL THEN 1 ELSE 0 END'],
        ['DATAPAUSADO', 'pausadoEm', 'date'],
        ['CODIGOBARRA', 'codigoBarras', 'string'],
        ['CODIGOGUID', 'guid', 'string'],
    ]),
    defineEntity('origensPedido', 'PEDIDOORIGEM', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['DATAINSERT', 'criadoEm', 'date'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'ativo', 'boolean', 'CASE WHEN DATADELETE IS NULL THEN 1 ELSE 0 END'],
        ['DESCRICAO', 'descricao', 'string'],
    ]),
    defineEntity('pedidos', 'PEDIDOS', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['CODIGOCOLABORADOR', 'colaboradorId', 'integer'],
        ['DATAABERTURA', 'abertoEm', 'date'],
        ['DATAFECHAMENTO', 'fechadoEm', 'date'],
        ['NUMERO', 'numero', 'integer'],
        ['SUBTOTALPAGO', 'subtotalPago', 'number'],
        ['TOTALSERVICO', 'totalServico', 'number'],
        ['VALORTOTALITENS', 'valorItens', 'number'],
        ['TOTALDESCONTO', 'totalDesconto', 'number'],
        ['CODIGOCONTATOFIADO', 'contatoFiadoId', 'integer'],
        ['VALORENTREGA', 'valorEntrega', 'number'],
        ['CODIGOCONTATOCLIENTE', 'clienteId', 'integer', 'COALESCE(CODIGOCONTATOCLIENTE, CODIGOCONTATOFIADO)'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'cancelado', 'boolean', 'CASE WHEN DATADELETE IS NULL THEN 0 ELSE 1 END'],
        ['QUANTIDADEPESSOAS', 'quantidadePessoas', 'integer'],
        ['CODIGOPEDIDOORIGEM', 'origemId', 'integer'],
        ['PERCENTUALDESCONTO', 'percentualDesconto', 'number'],
        ['PERCENTUALTAXASERVICO', 'percentualServico', 'number'],
        ['TOTALACRESCIMO', 'totalAcrescimo', 'number'],
        ['VALORTROCO', 'valorTroco', 'number'],
        ['VALORTOTAL', 'valorTotal', 'number'],
        ['NOME', 'nome', 'string'],
    ]),
    defineEntity('itensPedido', 'ITENSPEDIDO', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['CODIGOPEDIDO', 'pedidoId', 'integer'],
        ['CODIGOPRODUTO', 'produtoId', 'integer', 'COALESCE(IP.CODIGOPRODUTO, PD.CODIGOPRODUTO)'],
        ['QUANTIDADE', 'quantidade', 'number'],
        ['VALORUNITARIO', 'valorUnitario', 'number'],
        ['PRECOCUSTO', 'precoCusto', 'number'],
        ['DATAHORACADASTRO', 'cadastradoEm', 'date'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'cancelado', 'boolean', 'CASE WHEN IP.DATADELETE IS NULL THEN 0 ELSE 1 END'],
        ['DATAHORAPRODUZIDO', 'produzidoEm', 'date'],
        ['DATAHORAENTREGUE', 'entregueEm', 'date'],
        ['CODIGOPAGAMENTO', 'pagamentoId', 'integer'],
        ['CODIGOPRODUTODETALHE', 'produtoDetalheId', 'integer'],
        ['CODIGOPAI', 'itemPaiId', 'integer'],
        ['VALORGORJETA', 'gorjeta', 'number'],
        ['VALORDESCONTO', 'desconto', 'number'],
        ['VALORITEM', 'valorItem', 'number'],
        ['VALORCOMPLEMENTO', 'valorComplemento', 'number'],
        ['VALORFILHO', 'valorFilho', 'number'],
        ['VALORTOTAL', 'valorTotal', 'number'],
        ['NOMEPRODUTO', 'nomeProduto', 'string'],
        ['DETALHES', 'detalhes', 'string'],
        ['CODIGOPEDIDOORIGEM', 'origemId', 'integer'],
    ], {
        alias: 'IP',
        joins: 'LEFT JOIN PRODUTODETALHE PD ON PD.CODIGO = IP.CODIGOPRODUTODETALHE',
    }),
    defineEntity('pagamentos', 'PAGAMENTOS', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['CODIGOPEDIDO', 'pedidoId', 'integer'],
        ['CODIGOFORMAPAGAMENTO', 'formaPagamentoId', 'integer'],
        ['VALOR', 'valor', 'number'],
        ['DATAPAGAMENTO', 'pagoEm', 'date'],
        ['CODIGOCONTATO', 'contatoId', 'integer', 'COALESCE(PG.CODIGOCONTATO, PE.CODIGOCONTATOCLIENTE, PE.CODIGOCONTATOFIADO)'],
        ['CODIGOCONTACORRENTE', 'contaCorrenteId', 'integer'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'cancelado', 'boolean', 'CASE WHEN PG.DATADELETE IS NULL THEN 0 ELSE 1 END'],
        ['DATACREDITO', 'creditoEm', 'date'],
        ['PERCENTUALTAXA', 'percentualTaxa', 'number'],
        ['NROPARCELA', 'numeroParcela', 'integer'],
        ['VALORTROCO', 'valorTroco', 'number'],
        ['OBSERVACAO', 'observacao', 'string'],
        ['PREPAGO', 'prepago', 'boolean'],
    ], {
        alias: 'PG',
        joins: 'LEFT JOIN PEDIDOS PE ON PE.CODIGO = PG.CODIGOPEDIDO',
    }),
    defineEntity('formasPagamento', 'FORMASPAGAMENTO', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['ATIVO', 'ativo', 'boolean', 'CASE WHEN DATADELETE IS NULL AND ATIVO = 1 THEN 1 ELSE 0 END'],
        ['CODIGOFISCAL', 'codigoFiscal', 'integer'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['ONLINE', 'online', 'boolean'],
        ['SISTEMA', 'sistema', 'integer'],
        ['DESCRICAO', 'descricao', 'string'],
    ]),
    defineEntity('contaCorrente', 'CONTACORRENTE', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['CODIGOCLIENTE', 'clienteId', 'integer'],
        ['CODIGOPEDIDO', 'pedidoId', 'integer'],
        ['DATAHORA', 'ocorridoEm', 'date'],
        ['SALDOINICIAL', 'saldoInicial', 'number'],
        ['CREDITO', 'credito', 'number'],
        ['DEBITO', 'debito', 'number'],
        ['DEBITO', 'variacaoDivida', 'number', 'COALESCE(CREDITO, 0) + COALESCE(DEBITO, 0)'],
        ['SALDOFINAL', 'saldoFinal', 'number'],
        ['CODIGOPAGAMENTO', 'pagamentoId', 'integer'],
        ['CODIGOCONTAESTORNADA', 'contaEstornadaId', 'integer'],
        ['OBSERVACAO', 'observacao', 'string'],
        ['IMPORTADO', 'importado', 'boolean'],
    ]),
    defineEntity('entregas', 'DELIVERY', 'pedidoId', [
        ['CODIGOPEDIDO', 'pedidoId', 'integer'],
        ['FRETE', 'frete', 'number'],
        ['CODIGOCONTATO', 'contatoId', 'integer'],
        ['CODIGOTIPOENTREGA', 'tipoEntregaId', 'integer'],
        ['PREPAROPREVISTOEM', 'preparoPrevistoEm', 'date'],
        ['PREPAROINICIADOEM', 'preparoIniciadoEm', 'date'],
        ['SAIUENTREGAEM', 'saiuParaEntregaEm', 'date'],
        ['ENTREGAPREVISTAEM', 'entregaPrevistaEm', 'date'],
        ['ENTREGUEEM', 'entregueEm', 'date'],
        ['RETIRADAPREVISTAEM', 'retiradaPrevistaEm', 'date'],
        ['RETIRADOEM', 'retiradoEm', 'date'],
        ['PRONTOPARARETIRADAEM', 'prontoParaRetiradaEm', 'date'],
        ['CODIGOTAXAENTREGA', 'taxaEntregaId', 'integer'],
        ['CODIGOENDERECO', 'enderecoId', 'integer'],
        ['AGENDADO', 'agendado', 'boolean'],
        ['COMPLEMENTO', 'complemento', 'string'],
        ['REFERENCIA', 'referencia', 'string'],
        ['CIDADE', 'cidade', 'string'],
        ['NUMERO', 'numero', 'string'],
        ['NOME', 'nome', 'string'],
        ['ENDERECO', 'endereco', 'string'],
        ['BAIRRO', 'bairro', 'string'],
        ['UF', 'uf', 'string'],
        ['FONEPRINCIPAL', 'telefonePrincipal', 'string'],
        ['FONERECADOS', 'telefoneRecados', 'string'],
        ['FONECELULAR', 'celular', 'string'],
        ['CEP', 'cep', 'string'],
        ['STATUS', 'status', 'string'],
        ['OBSERVACAO', 'observacao', 'string'],
    ]),
    defineEntity('tiposEntrega', 'TIPOENTREGA', 'id', [
        ['CODIGO', 'id', 'integer'],
        ['DATAINSERT', 'criadoEm', 'date'],
        ['DATAUPDATE', 'atualizadoEm', 'date'],
        ['DATADELETE', 'excluidoEm', 'date'],
        ['DATADELETE', 'ativo', 'boolean', 'CASE WHEN DATADELETE IS NULL THEN 1 ELSE 0 END'],
        ['DESCRICAO', 'descricao', 'string'],
    ]),
]);

function defineEntity(key, table, primaryKey, fields, options = {}) {
    return Object.freeze({
        key,
        table,
        primaryKey,
        alias: options.alias || '',
        joins: options.joins || '',
        fields: Object.freeze(fields.map(([column, name, type, expression], index) => Object.freeze({
            column,
            name,
            type,
            expression: expression || '',
            alias: `F${String(index + 1).padStart(3, '0')}`,
        }))),
    });
}

function unique(values) {
    return [...new Set(values.filter(Boolean).map((value) => path.resolve(String(value))))];
}

function parseFirebirdMajor(value) {
    const match = String(value || '').match(/(?:firebird|WI-V|LI-V)[_\s-]*([45])(?:[._-]|\b)/i);
    return match ? Number(match[1]) : null;
}

function hasExecutables(directory, existsSync = fs.existsSync) {
    if (!directory) return null;
    const gbak = path.join(directory, 'gbak.exe');
    const isql = path.join(directory, 'isql.exe');
    return existsSync(gbak) && existsSync(isql) ? { gbak, isql } : null;
}

/**
 * Locates a matching gbak/isql pair from Firebird 5 or 4 on Windows.
 * Explicit tool paths are useful both for portable distributions and tests.
 */
function findFirebirdTools(options = {}) {
    const env = options.env || process.env;
    const existsSync = options.existsSync || fs.existsSync;
    const readdirSync = options.readdirSync || fs.readdirSync;
    const explicit = options.toolPaths || options.tools;

    if (explicit?.gbak && explicit?.isql) {
        if (options.verifyTools !== false && (!existsSync(explicit.gbak) || !existsSync(explicit.isql))) {
            throw new ConsumerBackupError(
                'FIREBIRD_TOOLS_NOT_FOUND',
                'Os executáveis informados do Firebird não foram encontrados.',
                { stage: 'tools' },
            );
        }
        return {
            gbak: path.resolve(explicit.gbak),
            isql: path.resolve(explicit.isql),
            binDir: path.dirname(path.resolve(explicit.gbak)),
            major: explicit.major || parseFirebirdMajor(explicit.gbak) || parseFirebirdMajor(explicit.isql),
        };
    }

    const directHomes = unique([
        options.firebirdHome,
        env.CONSUMER_FIREBIRD_HOME,
        env.FIREBIRD_HOME,
    ]);
    const programRoots = unique([
        env.ProgramW6432,
        env.ProgramFiles,
        env.PROGRAMFILES,
        env['ProgramFiles(x86)'],
        env['PROGRAMFILES(X86)'],
        process.platform === 'win32' ? 'C:\\Program Files' : null,
        process.platform === 'win32' ? 'C:\\Program Files (x86)' : null,
    ]);
    const conventionalHomes = [];

    for (const root of programRoots) {
        const firebirdRoot = path.join(root, 'Firebird');
        for (const folder of ['Firebird_5_0', 'Firebird_5.0', 'Firebird_4_0', 'Firebird_4.0']) {
            conventionalHomes.push(path.join(firebirdRoot, folder));
        }
        try {
            const installed = readdirSync(firebirdRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && /^Firebird[_ .-]?[45](?:[_ .-]|$)/i.test(entry.name))
                .map((entry) => path.join(firebirdRoot, entry.name))
                .sort((left, right) => (parseFirebirdMajor(right) || 0) - (parseFirebirdMajor(left) || 0));
            conventionalHomes.push(...installed);
        } catch {
            // A missing Program Files/Firebird folder is normal.
        }
    }

    const pathHomes = String(env.PATH || '')
        .split(path.delimiter)
        .filter((entry) => /firebird/i.test(entry) && /(?:^|[^0-9])[45](?:[^0-9]|$)/.test(entry));
    const candidates = unique([...directHomes, ...conventionalHomes, ...pathHomes]);

    for (const candidate of candidates) {
        const tools = hasExecutables(candidate, existsSync)
            || hasExecutables(path.join(candidate, 'bin'), existsSync);
        if (!tools) continue;
        const major = parseFirebirdMajor(candidate);
        if (major !== 4 && major !== 5 && !directHomes.includes(path.resolve(candidate))) continue;
        return { ...tools, binDir: path.dirname(tools.gbak), major };
    }

    throw new ConsumerBackupError(
        'FIREBIRD_TOOLS_NOT_FOUND',
        'Firebird 4 ou 5 não foi encontrado. Instale o Firebird ou informe o diretório dos executáveis.',
        { stage: 'tools' },
    );
}

function makeAbortError() {
    const error = new ConsumerBackupError('IMPORT_ABORTED', 'A importação do backup foi cancelada.', {
        stage: 'process',
    });
    error.name = 'AbortError';
    return error;
}

function runProcess(command, args, options = {}) {
    const spawn = options.spawn || childProcess.spawn;
    const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(makeAbortError());
            return;
        }

        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd,
                env: options.env || process.env,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            reject(new ConsumerBackupError('PROCESS_START_FAILED', 'Não foi possível iniciar uma ferramenta do Firebird.', {
                stage: options.stage || 'process',
                cause: error,
            }));
            return;
        }

        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        let terminationError = null;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const stopWith = (error) => {
            terminationError = terminationError || error;
            try { child.kill(); } catch { /* process may already be closed */ }
        };
        const collect = (target) => (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += buffer.length;
            if (outputBytes > maxOutputBytes) {
                stopWith(new ConsumerBackupError(
                    'PROCESS_OUTPUT_LIMIT',
                    'A ferramenta do Firebird produziu uma saída maior que o limite seguro.',
                    { stage: options.stage || 'process' },
                ));
                return;
            }
            target.push(buffer);
        };
        const onAbort = () => stopWith(makeAbortError());
        const timer = options.timeoutMs > 0
            ? setTimeout(() => stopWith(new ConsumerBackupError(
                'PROCESS_TIMEOUT',
                'A ferramenta do Firebird excedeu o tempo limite.',
                { stage: options.stage || 'process' },
            )), options.timeoutMs)
            : null;

        child.stdout.on('data', collect(stdout));
        child.stderr.on('data', collect(stderr));
        child.on('error', (error) => finish(reject, new ConsumerBackupError(
            'PROCESS_START_FAILED',
            'Não foi possível executar uma ferramenta do Firebird.',
            { stage: options.stage || 'process', cause: error },
        )));
        child.on('close', (code, signal) => {
            if (terminationError) {
                finish(reject, terminationError);
                return;
            }
            const result = {
                code: Number.isInteger(code) ? code : -1,
                signal: signal || null,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            };
            if (result.code !== 0) {
                finish(reject, processFailure(options.stage, result));
                return;
            }
            finish(resolve, result);
        });

        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.input === undefined || options.input === null) child.stdin.end();
        else child.stdin.end(String(options.input), 'utf8');
    });
}

function cleanDiagnostic(value) {
    return String(value || '')
        .replace(/password\s*[=:]\s*\S+/gi, 'password=<omitida>')
        .replace(/ISC_PASSWORD\s*[=:]\s*\S+/gi, 'ISC_PASSWORD=<omitida>')
        .trim()
        .slice(0, 4000);
}

function processFailure(stage, result) {
    const diagnostic = cleanDiagnostic(result.stderr || result.stdout);
    const suffix = diagnostic ? ` Detalhe técnico: ${diagnostic}` : '';
    return new ConsumerBackupError(
        stage === 'restore' ? 'RESTORE_FAILED' : 'QUERY_FAILED',
        `${stage === 'restore' ? 'Não foi possível restaurar' : 'Não foi possível ler'} o backup do Consumer.${suffix}`,
        { stage: stage || 'process', details: { exitCode: result.code } },
    );
}

async function invokeProcess(exec, command, args, options) {
    let result;
    try {
        result = await exec(command, args, options);
    } catch (error) {
        if (error instanceof ConsumerBackupError) throw error;
        throw new ConsumerBackupError(
            options.stage === 'restore' ? 'RESTORE_FAILED' : 'QUERY_FAILED',
            options.stage === 'restore'
                ? 'Não foi possível restaurar o backup do Consumer.'
                : 'Não foi possível ler o banco restaurado do Consumer.',
            { stage: options.stage, cause: error },
        );
    }

    if (typeof result === 'string' || Buffer.isBuffer(result)) {
        return { code: 0, stdout: result.toString(), stderr: '' };
    }
    const normalized = {
        code: Number.isInteger(result?.code) ? result.code : 0,
        stdout: Buffer.isBuffer(result?.stdout) ? result.stdout.toString('utf8') : String(result?.stdout || ''),
        stderr: Buffer.isBuffer(result?.stderr) ? result.stderr.toString('utf8') : String(result?.stderr || ''),
    };
    if (normalized.code !== 0) throw processFailure(options.stage, normalized);
    return normalized;
}

function firebirdEnvironment(options = {}) {
    const source = options.env || process.env;
    const user = options.username || source.CONSUMER_FIREBIRD_USER || source.ISC_USER || 'SYSDBA';
    const password = options.password
        ?? source.CONSUMER_FIREBIRD_PASSWORD
        ?? source.ISC_PASSWORD
        ?? 'masterkey';
    return {
        ...source,
        ISC_USER: user,
        ISC_PASSWORD: password,
    };
}

async function validateBackupFile(backupPath, options = {}) {
    if (typeof backupPath !== 'string' || !backupPath.trim()) {
        throw new ConsumerBackupError('INVALID_BACKUP_PATH', 'Selecione um arquivo de backup do Consumer.', {
            stage: 'validation',
        });
    }
    const resolved = path.resolve(backupPath);
    if (!SUPPORTED_BACKUP_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
        throw new ConsumerBackupError('INVALID_BACKUP_EXTENSION', 'O arquivo precisa ser um backup FB, FBCONSUMER, FBK, GBK, BAK ou BACKUP.', {
            stage: 'validation',
        });
    }

    let stats;
    try {
        stats = await (options.fsPromises || fsp).stat(resolved);
    } catch (error) {
        throw new ConsumerBackupError('BACKUP_NOT_FOUND', 'O arquivo de backup não foi encontrado.', {
            stage: 'validation',
            cause: error,
        });
    }
    if (!stats.isFile() || stats.size === 0) {
        throw new ConsumerBackupError('INVALID_BACKUP_FILE', 'O backup selecionado está vazio ou não é um arquivo.', {
            stage: 'validation',
        });
    }
    return { path: resolved, size: stats.size };
}

function sqlExpression(field, definition) {
    const value = field.expression
        || (definition.alias ? `${definition.alias}.${field.column}` : field.column);
    if (field.type === 'string') {
        return `REPLACE(REPLACE(${value}, ASCII_CHAR(13), ' '), ASCII_CHAR(10), ' ')`;
    }
    return value;
}

function buildEntityQuery(definition) {
    const fields = definition.fields
        .map((field) => `    ${sqlExpression(field, definition)} AS ${field.alias}`)
        .join(',\n');
    const primary = definition.fields.find((field) => field.name === definition.primaryKey);
    const orderBy = definition.alias ? `${definition.alias}.${primary.column}` : primary.column;
    const from = `${definition.table}${definition.alias ? ` ${definition.alias}` : ''}`;
    return [
        'SET BAIL ON;',
        'SET LIST ON;',
        'SET COUNT OFF;',
        `SELECT\n${fields}`,
        `FROM ${from}${definition.joins ? `\n${definition.joins}` : ''}`,
        `ORDER BY ${orderBy};`,
        'QUIT;',
        '',
    ].join('\n');
}

function parseNumber(value, integer) {
    const source = String(value || '').trim();
    if (!source) return null;
    const normalized = source.includes('.') || !source.includes(',') ? source : source.replace(',', '.');
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) return value;
    return parsed;
}

function parseBoolean(value) {
    const source = String(value || '').trim().toUpperCase();
    if (!source) return null;
    if (['1', 'S', 'Y', 'SIM', 'TRUE', 'T'].includes(source)) return true;
    if (['0', 'N', 'NAO', 'NÃO', 'FALSE', 'F'].includes(source)) return false;
    return value;
}

function parseDate(value) {
    const source = String(value || '').trim();
    if (!source) return null;
    const match = source.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?)?(?:\s*([+-]\d{2}:?\d{2}|Z))?$/i);
    if (!match) return source;
    if (!match[2]) return match[1];
    const milliseconds = match[3] ? `.${match[3].slice(0, 3).padEnd(3, '0')}` : '';
    const zone = match[4] || '';
    return `${match[1]}T${match[2]}${milliseconds}${zone}`;
}

function parseFieldValue(value, type) {
    if (/^<null>$/i.test(String(value || '').trim())) return null;
    if (type === 'integer') return parseNumber(value, true);
    if (type === 'number') return parseNumber(value, false);
    if (type === 'boolean') return parseBoolean(value);
    if (type === 'date') return parseDate(value);
    return String(value ?? '');
}

/**
 * Parses Firebird isql's SET LIST output. A definition can be an entity
 * descriptor or an array of { alias, name, type } column descriptors.
 */
function parseSetListOutput(output, definition) {
    const fields = Array.isArray(definition) ? definition : definition?.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
        throw new TypeError('Uma definição de colunas é obrigatória para interpretar SET LIST.');
    }
    const aliases = new Map(fields.map((field) => [String(field.alias).toUpperCase(), field]));
    const firstAlias = String(fields[0].alias).toUpperCase();
    const records = [];
    let current = null;
    let lastField = null;

    const commit = () => {
        if (!current || Object.keys(current).length === 0) return;
        records.push(current);
        current = null;
        lastField = null;
    };

    for (const originalLine of String(output || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = originalLine.replace(/^SQL>\s*/i, '');
        const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s+(.*)$/);
        const alias = match?.[1]?.toUpperCase();
        const field = alias ? aliases.get(alias) : null;
        if (field) {
            if (alias === firstAlias && current && Object.prototype.hasOwnProperty.call(current, fields[0].name)) {
                commit();
            }
            if (!current) current = {};
            current[field.name] = parseFieldValue(match[2], field.type);
            lastField = field;
            continue;
        }

        if (!line.trim()) continue;
        if (current && lastField?.type === 'string' && !/^(Database:|Statement failed|Dynamic SQL Error|-SQL error)/i.test(line.trim())) {
            current[lastField.name] += `\n${line}`;
        }
    }
    commit();
    return records;
}

function validateRecord(record, definition, index, errors) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        errors.push(`${definition.key}[${index}] precisa ser um objeto.`);
        return;
    }
    for (const field of definition.fields) {
        const value = record[field.name];
        if (value === null || value === undefined) continue;
        if (field.type === 'integer' && !Number.isSafeInteger(value)) {
            errors.push(`${definition.key}[${index}].${field.name} precisa ser um inteiro seguro.`);
        } else if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
            errors.push(`${definition.key}[${index}].${field.name} precisa ser um número finito.`);
        } else if (field.type === 'boolean' && typeof value !== 'boolean') {
            errors.push(`${definition.key}[${index}].${field.name} precisa ser booleano.`);
        } else if (field.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))) {
            errors.push(`${definition.key}[${index}].${field.name} precisa estar no formato ISO.`);
        } else if (field.type === 'string' && typeof value !== 'string') {
            errors.push(`${definition.key}[${index}].${field.name} precisa ser texto.`);
        }
    }
    if (!Number.isSafeInteger(record[definition.primaryKey])) {
        errors.push(`${definition.key}[${index}].${definition.primaryKey} é obrigatório.`);
    }
}

function validateSnapshot(snapshot) {
    const errors = [];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return { valid: false, errors: ['O snapshot precisa ser um objeto.'] };
    }
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        errors.push(`schemaVersion precisa ser ${SNAPSHOT_SCHEMA_VERSION}.`);
    }
    if (!snapshot.entities || typeof snapshot.entities !== 'object' || Array.isArray(snapshot.entities)) {
        errors.push('entities precisa ser um objeto.');
        return { valid: false, errors };
    }

    for (const definition of ENTITY_DEFINITIONS) {
        const records = snapshot.entities[definition.key];
        if (!Array.isArray(records)) {
            errors.push(`entities.${definition.key} precisa ser uma lista.`);
            continue;
        }
        const identifiers = new Set();
        records.forEach((record, index) => {
            validateRecord(record, definition, index, errors);
            const id = record?.[definition.primaryKey];
            if (!Number.isSafeInteger(id)) return;
            if (identifiers.has(id)) errors.push(`entities.${definition.key} contém identificador duplicado.`);
            identifiers.add(id);
        });
        if (snapshot.counts && snapshot.counts[definition.key] !== records.length) {
            errors.push(`counts.${definition.key} não corresponde à quantidade extraída.`);
        }
    }
    return { valid: errors.length === 0, errors };
}

async function removeTemporaryDirectory(directory, fsPromises = fsp) {
    if (!directory) return;
    await fsPromises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 150,
    });
}

function notifyProgress(listener, stage, message, current, total) {
    if (typeof listener !== 'function') return;
    try {
        listener({ stage, message, current, total });
    } catch {
        // Progress callbacks must never interrupt extraction or cleanup.
    }
}

/**
 * Restores a .fbconsumer/.fb backup to an isolated read-only Firebird database,
 * extracts the supported entities, and removes the restored database.
 */
async function extractConsumerBackup(backupPath, options = {}) {
    const fsPromises = options.fsPromises || fsp;
    const backup = await validateBackupFile(backupPath, { fsPromises });
    const tools = findFirebirdTools(options);
    const exec = options.exec || runProcess;
    const processEnv = firebirdEnvironment(options);
    const temporaryRoot = path.resolve(options.tempRoot || os.tmpdir());
    const tempDirectory = await fsPromises.mkdtemp(path.join(temporaryRoot, 'valeverde-consumer-'));
    const databasePath = path.join(tempDirectory, 'consumer-read-only.fdb');
    const databaseTarget = `${options.host || 'localhost'}:${databasePath}`;
    let primaryError = null;
    let snapshot;
    let sourceFormat = 'consumer-firebird-backup';

    notifyProgress(options.onProgress, 'restore', 'Restaurando uma cópia temporária e somente leitura...', 0, ENTITY_DEFINITIONS.length + 1);
    try {
        try {
            await invokeProcess(exec, tools.gbak, [
                '-create_database',
                '-mode',
                'read_only',
                backup.path,
                databaseTarget,
            ], {
                env: processEnv,
                signal: options.signal,
                timeoutMs: options.restoreTimeoutMs || DEFAULT_RESTORE_TIMEOUT_MS,
                maxOutputBytes: options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
                stage: 'restore',
            });
        } catch (restoreError) {
            if (path.extname(backup.path).toLowerCase() !== '.fb' || options.allowRawDatabase === false) {
                throw restoreError;
            }
            notifyProgress(options.onProgress, 'restore', 'Criando uma cópia isolada do banco Firebird...', 0, ENTITY_DEFINITIONS.length + 1);
            try {
                await fsPromises.copyFile(backup.path, databasePath);
            } catch (copyError) {
                const failure = new ConsumerBackupError(
                    'DATABASE_COPY_FAILED',
                    'Não foi possível criar uma cópia isolada do arquivo .fb.',
                    { stage: 'restore', cause: copyError },
                );
                failure.restoreError = restoreError;
                throw failure;
            }
            sourceFormat = 'consumer-firebird-database-copy';
        }

        const entities = {};
        for (let index = 0; index < ENTITY_DEFINITIONS.length; index += 1) {
            const definition = ENTITY_DEFINITIONS[index];
            notifyProgress(
                options.onProgress,
                'extract',
                `Lendo ${definition.key}...`,
                index + 1,
                ENTITY_DEFINITIONS.length + 1,
            );
            const result = await invokeProcess(exec, tools.isql, [
                '-q',
                '-ch',
                'UTF8',
                databaseTarget,
            ], {
                env: processEnv,
                input: buildEntityQuery(definition),
                signal: options.signal,
                timeoutMs: options.queryTimeoutMs || DEFAULT_QUERY_TIMEOUT_MS,
                maxOutputBytes: options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
                stage: 'query',
            });
            entities[definition.key] = parseSetListOutput(result.stdout, definition);
        }

        const counts = Object.fromEntries(ENTITY_DEFINITIONS.map((definition) => [
            definition.key,
            entities[definition.key].length,
        ]));
        const now = options.now instanceof Date
            ? options.now
            : (typeof options.now === 'function' ? options.now() : new Date());
        snapshot = {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            source: {
                format: sourceFormat,
                fileName: path.basename(backup.path),
                sizeBytes: backup.size,
            },
            extractedAt: new Date(now).toISOString(),
            entities,
            counts,
        };
        const validation = validateSnapshot(snapshot);
        if (!validation.valid) {
            throw new ConsumerBackupError(
                'INVALID_SNAPSHOT',
                'Os dados extraídos do Consumer não passaram pela validação de integridade.',
                { stage: 'validation', details: { errors: validation.errors } },
            );
        }
        notifyProgress(
            options.onProgress,
            'complete',
            'Backup do Consumer lido com sucesso.',
            ENTITY_DEFINITIONS.length + 1,
            ENTITY_DEFINITIONS.length + 1,
        );
    } catch (error) {
        primaryError = error instanceof ConsumerBackupError
            ? error
            : new ConsumerBackupError('EXTRACTION_FAILED', 'Não foi possível extrair o backup do Consumer.', {
                stage: 'extract',
                cause: error,
            });
    } finally {
        notifyProgress(options.onProgress, 'cleanup', 'Removendo a cópia temporária...', null, null);
        try {
            await removeTemporaryDirectory(tempDirectory, fsPromises);
        } catch (cleanupError) {
            if (!primaryError) {
                primaryError = new ConsumerBackupError(
                    'CLEANUP_FAILED',
                    'Os dados foram lidos, mas a cópia temporária do banco não pôde ser removida.',
                    { stage: 'cleanup', cause: cleanupError },
                );
            } else {
                primaryError.cleanupError = cleanupError;
            }
        }
    }

    if (primaryError) throw primaryError;
    return snapshot;
}

module.exports = {
    ConsumerBackupError,
    ENTITY_DEFINITIONS,
    SNAPSHOT_SCHEMA_VERSION,
    buildEntityQuery,
    extractConsumerBackup,
    findFirebirdTools,
    parseSetListOutput,
    runProcess,
    validateBackupFile,
    validateSnapshot,
};
