import { IsEnum } from 'class-validator';

export enum PackingTemplate {
  BEACH = 'BEACH',
  CAMPING = 'CAMPING',
  CITY = 'CITY',
  ESSENTIALS = 'ESSENTIALS',
}

export class ApplyTemplateDto {
  @IsEnum(PackingTemplate)
  template: PackingTemplate;
}
