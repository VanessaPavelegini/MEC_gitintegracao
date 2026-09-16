import { HttpClient, HttpClientResponse } from '@microsoft/sp-http';

export interface IRetryResult {
  success: boolean;
  message: string;
  gitlabIid: number;
  plannerTaskId?: string;
}

export class FunctionService {
  private httpClient: HttpClient;
  private functionUrl: string;
  private functionKey: string;

  constructor(httpClient: HttpClient, functionUrl: string, functionKey: string) {
    this.httpClient = httpClient;
    this.functionUrl = (functionUrl || '').replace(/\/+$/, '');
    this.functionKey = functionKey || '';
  }

  /**
   * Chama POST /api/gitlab-planner-sync?iid=X na Azure Function
   * para sincronizar manualmente uma issue.
   */
  public async retrySync(gitlabIid: number): Promise<IRetryResult> {
    if (!this.functionUrl) {
      throw new Error('URL da Function não configurada. Preencha "URL da Function" no painel de propriedades.');
    }
    if (!this.functionKey) {
      throw new Error('Chave da Function não configurada. Preencha "Function Key" no painel de propriedades.');
    }

    const url = `${this.functionUrl}/api/gitlab-planner-sync?iid=${encodeURIComponent(String(gitlabIid))}`;

    let response: HttpClientResponse;
    try {
      response = await this.httpClient.post(
        url,
        HttpClient.configurations.v1,
        {
          headers: {
            'x-functions-key': this.functionKey,
            'Accept': 'application/json'
          },
          mode: 'cors'
        }
      );
    } catch (networkErr: any) {
      throw new Error(`Falha de rede ao chamar a Function: ${networkErr?.message || networkErr}`);
    }

    const status = response.status;
    let body: any = null;
    try {
      body = await response.json();
    } catch {
      // corpo vazio ou não-JSON
    }

    if (status >= 200 && status < 300 && body && body.success !== false) {
      return {
        success: true,
        message: body.message || 'Sincronização concluída.',
        gitlabIid,
        plannerTaskId: body.plannerTaskId
      };
    }

    const errMsg = (body && (body.error || body.message)) || `Function retornou HTTP ${status}`;
    return {
      success: false,
      message: errMsg,
      gitlabIid
    };
  }
}
