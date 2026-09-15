import { WebPartContext } from '@microsoft/sp-webpart-base';

export interface IGitlabPlannerMonitorProps {
  title: string;
  refreshInterval: number;
  showMockData: boolean;
  dataverseUrl: string;
  context: WebPartContext;
  onConfigure: () => void;
}
