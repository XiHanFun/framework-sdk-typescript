import { MessageCatalog } from '../primitives/index.ts';

/**
 * 插件运行时自己的消息目录：10 种区域（RFC-0010），键与参数同 {@link PluginMessageKey}
 *
 * @remarks
 * 模板逐字取自参考实现插件协议包的语言文件；宿主收到这些错误时按消息键用自己的目录翻译，
 * 这里的文案只用于插件这一侧的 `text` 与日志
 */
export const pluginTemplates: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'en-US': Object.freeze({
    'plugins.callback.denied':
      "Plugin '{id}' may not use permission '{permission}': it must be declared in the manifest and granted by the host.",
    'plugins.callback.tenant_denied':
      "Plugin '{id}' may not act in tenant '{tenant}': a callback can only carry the tenant of a call the host has handed to the plugin.",
    'plugins.callback.session_invalid': 'The plugin session token is missing or invalid.',
    'plugins.process.failed': "Plugin '{id}' failed during {phase}: {reason}",
    'plugins.process.unavailable': "Plugin '{id}' is not available (state: {state}).",
  }),
  'zh-CN': Object.freeze({
    'plugins.callback.denied': "插件 '{id}' 不能使用权限 '{permission}'：权限须在清单中声明并由宿主授予。",
    'plugins.callback.tenant_denied':
      "插件 '{id}' 不能在租户 '{tenant}' 中执行：回调只能带宿主交给插件处理的调用的租户。",
    'plugins.callback.session_invalid': '插件会话令牌缺失或无效。',
    'plugins.process.failed': "插件 '{id}' 在 {phase} 阶段失败：{reason}",
    'plugins.process.unavailable': "插件 '{id}' 不可用（状态：{state}）。",
  }),
  'zh-TW': Object.freeze({
    'plugins.callback.denied': "外掛 '{id}' 不能使用權限 '{permission}'：權限須在清單中宣告並由主機授予。",
    'plugins.callback.tenant_denied':
      "外掛 '{id}' 不能在租用戶 '{tenant}' 中執行：回呼只能帶主機交給外掛處理的呼叫的租用戶。",
    'plugins.callback.session_invalid': '外掛工作階段權杖缺失或無效。',
    'plugins.process.failed': "外掛 '{id}' 在 {phase} 階段失敗：{reason}",
    'plugins.process.unavailable': "外掛 '{id}' 無法使用（狀態：{state}）。",
  }),
  'ja-JP': Object.freeze({
    'plugins.callback.denied':
      "プラグイン '{id}' は権限 '{permission}' を使用できません。権限はマニフェストで宣言され、ホストから付与されている必要があります。",
    'plugins.callback.tenant_denied':
      "プラグイン '{id}' はテナント '{tenant}' で実行できません。コールバックが持てるのは、ホストがプラグインに渡した呼び出しのテナントだけです。",
    'plugins.callback.session_invalid': 'プラグインのセッショントークンがないか無効です。',
    'plugins.process.failed': "プラグイン '{id}' は {phase} で失敗しました: {reason}",
    'plugins.process.unavailable': "プラグイン '{id}' は利用できません (状態: {state})。",
  }),
  'ko-KR': Object.freeze({
    'plugins.callback.denied':
      "플러그인 '{id}'은(는) 권한 '{permission}'을(를) 사용할 수 없습니다. 권한은 매니페스트에 선언되고 호스트가 부여해야 합니다.",
    'plugins.callback.tenant_denied':
      "플러그인 '{id}'은(는) 테넌트 '{tenant}'에서 실행할 수 없습니다. 콜백에는 호스트가 플러그인에 맡긴 호출의 테넌트만 담을 수 있습니다.",
    'plugins.callback.session_invalid': '플러그인 세션 토큰이 없거나 잘못되었습니다.',
    'plugins.process.failed': "플러그인 '{id}'이(가) {phase} 단계에서 실패했습니다: {reason}",
    'plugins.process.unavailable': "플러그인 '{id}'을(를) 사용할 수 없습니다 (상태: {state}).",
  }),
  'de-DE': Object.freeze({
    'plugins.callback.denied':
      "Das Plugin '{id}' darf die Berechtigung '{permission}' nicht verwenden: Sie muss im Manifest deklariert und vom Host erteilt sein.",
    'plugins.callback.tenant_denied':
      "Das Plugin '{id}' darf nicht im Mandanten '{tenant}' handeln: Ein Rückruf kann nur den Mandanten eines Aufrufs tragen, den der Host an das Plugin übergeben hat.",
    'plugins.callback.session_invalid': 'Das Sitzungstoken des Plugins fehlt oder ist ungültig.',
    'plugins.process.failed': "Plugin '{id}' ist während {phase} fehlgeschlagen: {reason}",
    'plugins.process.unavailable': "Plugin '{id}' ist nicht verfügbar (Zustand: {state}).",
  }),
  'es-ES': Object.freeze({
    'plugins.callback.denied':
      "El plugin '{id}' no puede usar el permiso '{permission}': debe declararse en el manifiesto y concederlo el host.",
    'plugins.callback.tenant_denied':
      "El plugin '{id}' no puede actuar en el inquilino '{tenant}': una devolución de llamada solo puede llevar el inquilino de una llamada que el host haya entregado al plugin.",
    'plugins.callback.session_invalid': 'El token de sesión del plugin falta o no es válido.',
    'plugins.process.failed': "El plugin '{id}' falló durante {phase}: {reason}",
    'plugins.process.unavailable': "El plugin '{id}' no está disponible (estado: {state}).",
  }),
  'fr-FR': Object.freeze({
    'plugins.callback.denied':
      "Le plugin '{id}' ne peut pas utiliser la permission '{permission}' : elle doit être déclarée dans le manifeste et accordée par l'hôte.",
    'plugins.callback.tenant_denied':
      "Le plugin '{id}' ne peut pas agir dans le locataire '{tenant}' : un rappel ne peut porter que le locataire d'un appel que l'hôte a confié au plugin.",
    'plugins.callback.session_invalid': 'Le jeton de session du plugin est absent ou invalide.',
    'plugins.process.failed': "Le plugin '{id}' a échoué pendant {phase} : {reason}",
    'plugins.process.unavailable': "Le plugin '{id}' est indisponible (état : {state}).",
  }),
  'pt-BR': Object.freeze({
    'plugins.callback.denied':
      "O plugin '{id}' não pode usar a permissão '{permission}': ela deve ser declarada no manifesto e concedida pelo host.",
    'plugins.callback.tenant_denied':
      "O plugin '{id}' não pode agir no locatário '{tenant}': um retorno de chamada só pode levar o locatário de uma chamada que o host entregou ao plugin.",
    'plugins.callback.session_invalid': 'O token de sessão do plugin está ausente ou é inválido.',
    'plugins.process.failed': "O plugin '{id}' falhou durante {phase}: {reason}",
    'plugins.process.unavailable': "O plugin '{id}' não está disponível (estado: {state}).",
  }),
  'ru-RU': Object.freeze({
    'plugins.callback.denied':
      "Плагин '{id}' не может использовать разрешение '{permission}': оно должно быть объявлено в манифесте и предоставлено хостом.",
    'plugins.callback.tenant_denied':
      "Плагин '{id}' не может действовать в арендаторе '{tenant}': обратный вызов может нести только арендатора вызова, переданного хостом плагину.",
    'plugins.callback.session_invalid': 'Токен сеанса плагина отсутствует или недопустим.',
    'plugins.process.failed': "Плагин '{id}' завершился ошибкой на этапе {phase}: {reason}",
    'plugins.process.unavailable': "Плагин '{id}' недоступен (состояние: {state}).",
  }),
});

/**
 * {@link pluginTemplates} 组成的目录：请求的区域没有该键时回退到 `en-US`
 */
export const pluginMessages = new MessageCatalog(pluginTemplates);
