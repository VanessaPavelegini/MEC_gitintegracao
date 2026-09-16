import * as React from 'react';
import * as ReactDom from 'react-dom';
import { Version } from '@microsoft/sp-core-library';
import {
  IPropertyPaneConfiguration,
  PropertyPaneTextField,
  PropertyPaneToggle,
  PropertyPaneSlider
} from '@microsoft/sp-property-pane';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';

import * as strings from 'GitlabPlannerMonitorWebPartStrings';
import GitlabPlannerMonitor from './components/GitlabPlannerMonitor';
import { IGitlabPlannerMonitorProps } from './components/IGitlabPlannerMonitorProps';
import { DataverseService } from './services/DataverseService';

export interface IGitlabPlannerMonitorWebPartProps {
  title: string;
  refreshInterval: number;
  showMockData: boolean;
  dataverseUrl: string;
  functionUrl: string;
  functionKey: string;
}

export default class GitlabPlannerMonitorWebPart extends BaseClientSideWebPart<IGitlabPlannerMonitorWebPartProps> {

  public render(): void {
    const element: React.ReactElement<IGitlabPlannerMonitorProps> = React.createElement(
      GitlabPlannerMonitor,
      {
        title: this.properties.title,
        refreshInterval: this.properties.refreshInterval,
        showMockData: this.properties.showMockData,
        dataverseUrl: this.properties.dataverseUrl,
        functionUrl: this.properties.functionUrl,
        functionKey: this.properties.functionKey,
        context: this.context,
        onConfigure: () => this.context.propertyPane.open()
      }
    );

    ReactDom.render(element, this.domElement);
  }

  protected onDispose(): void {
    ReactDom.unmountComponentAtNode(this.domElement);
  }

  protected get dataVersion(): Version {
    return Version.parse('1.0');
  }

  protected getPropertyPaneConfiguration(): IPropertyPaneConfiguration {
    return {
      pages: [
        {
          header: {
            description: strings.PropertyPaneDescription
          },
          groups: [
            {
              groupName: strings.BasicGroupName,
              groupFields: [
                PropertyPaneTextField('title', {
                  label: 'Titulo'
                }),
                PropertyPaneSlider('refreshInterval', {
                  label: 'Intervalo de atualizacao (segundos)',
                  min: 10,
                  max: 300,
                  value: 30
                }),
                PropertyPaneToggle('showMockData', {
                  label: 'Usar dados de exemplo',
                  onText: 'Sim',
                  offText: 'Nao'
                }),
                PropertyPaneTextField('dataverseUrl', {
                  label: 'URL do Dataverse'
                })
              ]
            },
            {
              groupName: 'Azure Function (retry)',
              groupFields: [
                PropertyPaneTextField('functionUrl', {
                  label: 'URL da Function',
                  placeholder: 'https://func-gitintegracao-xxx.azurewebsites.net'
                }),
                PropertyPaneTextField('functionKey', {
                  label: 'Function Key (x-functions-key)',
                  description: 'Usado pelo botão "Tentar novamente" em cards com erro.'
                })
              ]
            }
          ]
        }
      ]
    };
  }
}
