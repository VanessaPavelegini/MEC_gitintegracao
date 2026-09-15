import { WebPartContext } from '@microsoft/sp-webpart-base';

export interface IMappingItem {
  id: string;
  gitlabIid: number;
  plannerTaskId: string;
  planId: string;
  title: string;
  status: string;
  lastSyncedAt: string;
  issueUrl: string;
  issueLabels: string;
  description: string;
}

export class DataverseService {
  private context: WebPartContext;
  private useMock: boolean;
  private dataverseUrl: string;

  constructor(context: WebPartContext, useMock: boolean, dataverseUrl: string) {
    this.context = context;
    this.useMock = useMock;
    this.dataverseUrl = dataverseUrl || 'https://org41ecace2.crm2.dynamics.com';
  }

  public async getMappings(): Promise<IMappingItem[]> {
    if (this.useMock) {
      return this._getMockData();
    }

    try {
      const client = await this.context.msGraphClientFactory.getClient('3');
      const result = await client
        .api(`${this.dataverseUrl}/api/data/v9.2/pmo_mapeamentoplanners?$top=200&$orderby=pmo_dataultimasincronizacao desc`)
        .get();

      return (result.value || []).map((r: any) => ({
        id: r.pmo_mapeamentoplannerid,
        gitlabIid: r.pmo_gitlab_iid || 0,
        plannerTaskId: r.pmo_plannertaskid || '',
        planId: r.pmo_plannerplanid || '',
        title: r.pmo_title || `#${r.pmo_gitlab_iid}`,
        status: r.pmo_statussincronizacao || 'Pendente',
        lastSyncedAt: r.pmo_dataultimasincronizacao || '',
        issueUrl: r.pmo_gitlab_url || '',
        issueLabels: r.pmo_issue_labels || '',
        description: r.pmo_description || ''
      }));
    } catch (err) {
      console.warn('[DataverseService] Erro ao buscar dados reais, usando mock:', err);
      return this._getMockData();
    }
  }

  private _getMockData(): IMappingItem[] {
    const now = Date.now();
    const min = 60 * 1000;

    return [
      {
        id: '1',
        gitlabIid: 42,
        plannerTaskId: 'abc123def456ghi789jkl012mno',
        planId: 'V6eQb5zdBkWHqIzlDh68o2UACro8',
        title: 'Implementar autenticacao OAuth2',
        status: 'Sincronizado',
        lastSyncedAt: new Date(now - 5 * min).toISOString(),
        issueUrl: 'https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/issues/42',
        issueLabels: 'em progresso, oauth',
        description: 'Configurar OAuth2 com provedores externos'
      },
      {
        id: '2',
        gitlabIid: 43,
        plannerTaskId: 'xyz789abc123def456ghi789jkl',
        planId: 'V6eQb5zdBkWHqIzlDh68o2UACro8',
        title: 'Validar fluxo de deploy',
        status: 'Sincronizado',
        lastSyncedAt: new Date(now - 15 * min).toISOString(),
        issueUrl: 'https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/issues/43',
        issueLabels: 'done, deploy',
        description: 'Validar pipeline de deploy automatizado'
      },
      {
        id: '3',
        gitlabIid: 44,
        plannerTaskId: '',
        planId: 'V6eQb5zdBkWHqIzlDh68o2UACro8',
        title: 'Atualizar documentacao',
        status: 'Pendente',
        lastSyncedAt: new Date(now - 60 * min).toISOString(),
        issueUrl: 'https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/issues/44',
        issueLabels: 'a fazer, docs',
        description: 'Documentar endpoints da API'
      },
      {
        id: '4',
        gitlabIid: 45,
        plannerTaskId: 'err123abc456def789ghi012jkl',
        planId: 'V6eQb5zdBkWHqIzlDh68o2UACro8',
        title: 'Refatorar modulo de sincronizacao',
        status: 'Erro',
        lastSyncedAt: new Date(now - 120 * min).toISOString(),
        issueUrl: 'https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/issues/45',
        issueLabels: 'bloqueado, bug',
        description: 'Erro 500 ao tentar sincronizar'
      },
      {
        id: '5',
        gitlabIid: 46,
        plannerTaskId: 'new123abc456def789ghi012jkl',
        planId: 'V6eQb5zdBkWHqIzlDh68o2UACro8',
        title: 'Configurar webhook GitLab',
        status: 'Sincronizado',
        lastSyncedAt: new Date(now - 2 * min).toISOString(),
        issueUrl: 'https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/issues/46',
        issueLabels: 'em revisao',
        description: 'Configurar URL do webhook com secret'
      }
    ];
  }
}
