import * as React from 'react';
import styles from './GitlabPlannerMonitor.module.scss';
import {
  PrimaryButton,
  Spinner,
  SpinnerSize,
  MessageBar,
  MessageBarType,
  Icon,
  TextField,
  Dropdown,
  IDropdownOption
} from '@fluentui/react';
import { WebPartContext } from '@microsoft/sp-webpart-base';
import { DataverseService, IMappingItem } from '../services/DataverseService';

export interface IGitlabPlannerMonitorProps {
  title: string;
  refreshInterval: number;
  showMockData: boolean;
  dataverseUrl: string;
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
}

export default class GitlabPlannerMonitor extends React.Component<IGitlabPlannerMonitorProps, IGitlabPlannerMonitorState> {
  private _service: DataverseService;
  private _intervalId: number | null = null;

  constructor(props: IGitlabPlannerMonitorProps) {
    super(props);
    this._service = new DataverseService(props.context, props.showMockData, props.dataverseUrl);

    this.state = {
      items: [],
      loading: true,
      error: null,
      searchTerm: '',
      statusFilter: 'Todos',
      lastRefresh: new Date()
    };
  }

  public componentDidMount(): void {
    this._loadData();
    this._startAutoRefresh();
  }

  public componentWillUnmount(): void {
    this._stopAutoRefresh();
  }

  public componentDidUpdate(prevProps: IGitlabPlannerMonitorProps): void {
    if (prevProps.refreshInterval !== this.props.refreshInterval) {
      this._stopAutoRefresh();
      this._startAutoRefresh();
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
    } catch (err) {
      this.setState({
        loading: false,
        error: err.message || 'Erro ao carregar dados'
      });
    }
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
      return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return dateStr;
    }
  }

  public render(): React.ReactElement<IGitlabPlannerMonitorProps> {
    const { items, loading, error, searchTerm, statusFilter, lastRefresh } = this.state;
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
            {filtered.map(item => (
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
                  <span className={`${styles.statusBadge} ${styles[`status_${item.status}`]}`}>
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
}
