import * as React from 'react';
import styles from './GitlabPlannerMonitor.module.scss';
import {
  PrimaryButton,
  DefaultButton,
  Spinner,
  SpinnerSize,
  MessageBar,
  MessageBarType,
  Icon,
  TextField,
  Dropdown
} from '@fluentui/react';
import { WebPartContext } from '@microsoft/sp-webpart-base';
import { DataverseService, IMappingItem } from '../services/DataverseService';
import { FunctionService } from '../services/FunctionService';

export interface IGitlabPlannerMonitorProps {
  title: string;
  refreshInterval: number;
  showMockData: boolean;
  dataverseUrl: string;
  functionUrl: string;
  functionKey: string;
  context: WebPartContext;
  onConfigure: () => void;
}

export interface IGitlabPlannerMonitorState {
  items: IMappingItem[];
  loading: boolean;
  error: string | null;
  searchTerm: string;
  statusFilter: string;
  lastRefresh: Date;
  retryingIid: number | null;
  retryFeedback: { type: 'success' | 'error'; text: string } | null;
}

export default class GitlabPlannerMonitor extends React.Component<IGitlabPlannerMonitorProps, IGitlabPlannerMonitorState> {
  private _service: DataverseService;
  private _functionService: FunctionService;
  private _intervalId: number | null = null;
  private _feedbackTimeoutId: number | null = null;

  constructor(props: IGitlabPlannerMonitorProps) {
    super(props);
    this._service = new DataverseService(props.context, props.showMockData, props.dataverseUrl);
    this._functionService = new FunctionService(
      props.context.httpClient,
      props.functionUrl,
      props.functionKey
    );

    this.state = {
      items: [],
      loading: true,
      error: null,
      searchTerm: '',
      statusFilter: 'Todos',
      lastRefresh: new Date(),
      retryingIid: null,
      retryFeedback: null
    };
  }

  public componentDidMount(): void {
    this._loadData();
    this._startAutoRefresh();
  }

  public componentWillUnmount(): void {
    this._stopAutoRefresh();
    if (this._feedbackTimeoutId !== null) {
      window.clearTimeout(this._feedbackTimeoutId);
    }
  }

  public componentDidUpdate(prevProps: IGitlabPlannerMonitorProps): void {
    if (prevProps.refreshInterval !== this.props.refreshInterval) {
      this._stopAutoRefresh();
      this._startAutoRefresh();
    }
    if (
      prevProps.functionUrl !== this.props.functionUrl ||
      prevProps.functionKey !== this.props.functionKey
    ) {
      this._functionService = new FunctionService(
        this.props.context.httpClient,
        this.props.functionUrl,
        this.props.functionKey
      );
    }
  }

  private _startAutoRefresh(): void {
    const ms = Math.max(10, this.props.refreshInterval) * 1000;
    this._intervalId = window.setInterval(() => {
      this._loadData();
    }, ms);
  }

  private _stopAutoRefresh(): void {
    if (this._intervalId !== null) {
      window.clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  private async _loadData(): Promise<void> {
    try {
      this.setState({ loading: true, error: null });
      const items = await this._service.getMappings();
      this.setState({
        items: items,
        loading: false,
        lastRefresh: new Date()
      });
    } catch (err: any) {
      this.setState({
        loading: false,
        error: (err && err.message) ? err.message : 'Erro ao carregar dados'
      });
    }
  }

  private async _handleRetry(item: IMappingItem): Promise<void> {
    if (this.state.retryingIid !== null) return; // já tem um retry em andamento

    this._clearRetryFeedback();

    try {
      this.setState({ retryingIid: item.gitlabIid, retryFeedback: null });
      const result = await this._functionService.retrySync(item.gitlabIid);

      if (result.success) {
        this._setRetryFeedback('success', `Issue #${item.gitlabIid} sincronizada.`);
      } else {
        this._setRetryFeedback('error', `Falha: ${result.message}`);
      }

      // Recarrega a lista para refletir o novo status vindo do Dataverse
      await this._loadData();
    } catch (err: any) {
      this._setRetryFeedback('error', (err && err.message) ? err.message : 'Falha ao tentar novamente');
    } finally {
      this.setState({ retryingIid: null });
    }
  }

  private _setRetryFeedback(type: 'success' | 'error', text: string): void {
    this.setState({ retryFeedback: { type, text } });
    if (this._feedbackTimeoutId !== null) {
      window.clearTimeout(this._feedbackTimeoutId);
    }
    this._feedbackTimeoutId = window.setTimeout(() => {
      this.setState({ retryFeedback: null });
      this._feedbackTimeoutId = null;
    }, 6000);
  }

  private _clearRetryFeedback(): void {
    if (this._feedbackTimeoutId !== null) {
      window.clearTimeout(this._feedbackTimeoutId);
      this._feedbackTimeoutId = null;
    }
    this.setState({ retryFeedback: null });
  }

  private _getFilteredItems(): IMappingItem[] {
    const { items, searchTerm, statusFilter } = this.state;
    let filtered = items;

    if (statusFilter !== 'Todos') {
      filtered = filtered.filter(i => i.status === statusFilter);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(i =>
        i.title.toLowerCase().includes(term) ||
        i.gitlabIid.toString().includes(term) ||
        (i.issueLabels && i.issueLabels.toLowerCase().includes(term))
      );
    }

    return filtered.sort((a, b) => {
      const da = a.lastSyncedAt ? new Date(a.lastSyncedAt).getTime() : 0;
      const db = b.lastSyncedAt ? new Date(b.lastSyncedAt).getTime() : 0;
      return db - da;
    });
  }

  private _getMetrics(): { total: number; synced: number; pending: number; errors: number } {
    const { items } = this.state;
    return {
      total: items.length,
      synced: items.filter(i => i.status === 'Sincronizado').length,
      pending: items.filter(i => i.status === 'Pendente').length,
      errors: items.filter(i => i.status === 'Erro').length
    };
  }

  private _formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return d.toLocaleString('pt-BR');
    } catch (e) {
      return dateStr;
    }
  }

  public render(): React.ReactElement<IGitlabPlannerMonitorProps> {
    const { items, loading, error, searchTerm, statusFilter, lastRefresh, retryingIid, retryFeedback } = this.state;
    const filtered = this._getFilteredItems();
    const metrics = this._getMetrics();

    return (
      <div className={styles.gitlabPlannerMonitor}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <Icon iconName="Sync" className={styles.headerIcon} />
            <h2 className={styles.title}>{this.props.title}</h2>
          </div>
          <div className={styles.controls}>
            <span className={styles.lastUpdate}>
              <Icon iconName="Clock" /> {lastRefresh.toLocaleTimeString('pt-BR')}
            </span>
            <PrimaryButton
              text="Atualizar"
              iconProps={{ iconName: 'Refresh' }}
              onClick={() => this._loadData()}
              disabled={loading}
            />
            <button
              className={styles.configButton}
              onClick={this.props.onConfigure}
              title="Configurar"
            >
              <Icon iconName="Settings" />
            </button>
          </div>
        </div>

        {error && (
          <MessageBar messageBarType={MessageBarType.error} isMultiline={false}>
            {error}
          </MessageBar>
        )}

        {retryFeedback && (
          <MessageBar
            messageBarType={retryFeedback.type === 'success' ? MessageBarType.success : MessageBarType.error}
            isMultiline={false}
            onDismiss={() => this._clearRetryFeedback()}
          >
            {retryFeedback.text}
          </MessageBar>
        )}

        <div className={styles.metrics}>
          <div className={`${styles.metricCard} ${styles.metricTotal}`}>
            <div className={styles.metricValue}>{metrics.total}</div>
            <div className={styles.metricLabel}>Total</div>
          </div>
          <div className={`${styles.metricCard} ${styles.metricSynced}`}>
            <div className={styles.metricValue}>{metrics.synced}</div>
            <div className={styles.metricLabel}>Sincronizados</div>
          </div>
          <div className={`${styles.metricCard} ${styles.metricPending}`}>
            <div className={styles.metricValue}>{metrics.pending}</div>
            <div className={styles.metricLabel}>Pendentes</div>
          </div>
          <div className={`${styles.metricCard} ${styles.metricError}`}>
            <div className={styles.metricValue}>{metrics.errors}</div>
            <div className={styles.metricLabel}>Erros</div>
          </div>
        </div>

        <div className={styles.filters}>
          <TextField
            placeholder="Buscar por titulo, IID ou labels..."
            value={searchTerm}
            onChange={(_, val) => this.setState({ searchTerm: val || '' })}
            iconProps={{ iconName: 'Search' }}
            styles={{ root: { width: '300px' } }}
          />
          <Dropdown
            selectedKey={statusFilter}
            options={[
              { key: 'Todos', text: 'Todos os status' },
              { key: 'Sincronizado', text: 'Sincronizados' },
              { key: 'Pendente', text: 'Pendentes' },
              { key: 'Erro', text: 'Erros' }
            ]}
            onChange={(_, opt) => this.setState({ statusFilter: opt?.text || 'Todos' })}
            styles={{ root: { width: '200px' } }}
          />
        </div>

        {loading && items.length === 0 ? (
          <div className={styles.loadingContainer}>
            <Spinner size={SpinnerSize.large} label="Carregando..." />
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            <Icon iconName="Info" /> Nenhum registro encontrado.
          </div>
        ) : (
          <div className={styles.list}>
            {filtered.map(item => {
        const statusKey = 'status_' + item.status as 'status_Sincronizado' | 'status_Pendente' | 'status_Erro';
        const statusClass = (styles as any)[statusKey] || '';
        const isError = item.status === 'Erro';
        const isRetrying = retryingIid === item.gitlabIid;
        return (
          <div key={item.id} className={styles.card}>
            <div className={styles.cardHeader}>
              <a
                href={item.issueUrl || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.cardTitle}
              >
                #{item.gitlabIid} - {item.title}
              </a>
              <span className={`${styles.statusBadge} ${statusClass}`}>
                {item.status}
              </span>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.cardMeta}>
                <Icon iconName="Tag" /> {item.issueLabels || 'Sem labels'}
              </div>
              <div className={styles.cardMeta}>
                <Icon iconName="Calendar" /> {this._formatDate(item.lastSyncedAt)}
              </div>
              {item.plannerTaskId && (
                <a
                  href={`https://tasks.office.com/mecbrasil.onmicrosoft.com/Home/Task/${item.plannerTaskId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.plannerLink}
                >
                  <Icon iconName="OpenInNewTab" /> Ver no Planner
                </a>
              )}
              {isError && (
                <div className={styles.retryRow}>
                  <DefaultButton
                    text={isRetrying ? 'Sincronizando...' : 'Tentar novamente'}
                    iconProps={{ iconName: 'Refresh' }}
                    onClick={() => this._handleRetry(item)}
                    disabled={isRetrying || retryingIid !== null}
                    className={styles.retryButton}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
          </div>
        )}
      </div>
    );
  }
}
