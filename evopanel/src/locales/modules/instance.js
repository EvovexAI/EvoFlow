import { _ } from '../helper.js'

export default {
  local: _('本机', 'Local', '本機', 'ローカル', '로컬', 'Cục bộ', 'Local', 'Local', 'Локальный', 'Local', 'Lokal'),
  remote: _('远程', 'Remote', '遠程', 'リモート', '원격', 'Từ xa', 'Remoto', 'Remoto', 'Удалённый', 'Distant', 'Remote'),
  docker: _('Docker'),
  switchHint: _('切换后，模型配置、Agent 等页面将管理对应实例', 'After switching, Models, Agents and other pages will manage the selected instance', '切換後，模型設定、Agent 等頁面將管理對應執行個體'),
  addInstance: _('添加实例', 'Add Instance', '新增執行個體', 'インスタンス追加', '인스턴스 추가', 'Thêm instance', 'Agregar instancia', 'Adicionar instância', 'Добавить экземпляр', 'Ajouter une instance', 'Instanz hinzufügen'),
  addRemote: _('添加远程实例', 'Add Remote Instance', '新增遠程執行個體', 'リモートインスタンス追加', '원격 인스턴스 추가', 'Thêm instance từ xa', 'Agregar instancia remota', 'Adicionar instância remota', 'Добавить удалённый', 'Ajouter une instance distante', 'Remote-Instanz hinzufügen'),
  namePlaceholder: _('远程服务器', 'Remote Server', '遠程伺服器'),
  endpointPlaceholder: _('http://192.168.1.100:1420'),
  nameLabel: _('名称', 'Name', '名稱', '名前', '이름', 'Tên', 'Nombre', 'Nome', 'Имя', 'Nom', 'Name'),
  endpointLabel: _('面板地址', 'Panel Address', '面板位址', 'パネルアドレス', '패널 주소', 'Địa chỉ panel', 'Dirección del panel', 'Endereço do painel', 'Адрес панели', 'Adresse du panneau', 'Panel-Adresse'),
  gwPortLabel: _('Gateway 端口（可选）', 'Gateway Port (optional)', 'Gateway 連接埠（可選）', 'Gateway ポート（任意）', 'Gateway 포트 (선택)'),
  nameRequired: _('请填写名称和面板地址', 'Please fill in name and endpoint', '請填寫名稱和面板位址'),
  endpointExists: _('该端点已存在', 'This endpoint already exists', '該端點已存在'),
  adding: _('添加中...', 'Adding...', '新增中...', 'Đang thêm...', 'Agregando...', 'Adicionando...', 'Добавление...', 'Ajout...', 'Wird hinzugefügt...'),
  switchedTo: _('已切换到 {name} — 模型配置、Agent 等将管理该实例', 'Switched to {name} — Models, Agents, etc. will manage this instance', '已切換到 {name} — 模型設定、Agent 等將管理該執行個體'),
  current: _('当前', 'Active', '目前', '現在', '현재', 'Hiện tại', 'Actual', 'Atual', 'Текущий', 'Actuel', 'Aktuell'),
  remoteHint: _('远程服务器需要运行 EvoPanel (serve.js)。', 'The remote server must be running EvoPanel (serve.js).', '遠程伺服器需要執行 EvoPanel (serve.js)。'),
  example: _('示例', 'Example', '範例', '例', '예시'),
}
