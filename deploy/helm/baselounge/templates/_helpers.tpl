{{/* Имя чарта. */}}
{{- define "baselounge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Полное имя ресурсов. */}}
{{- define "baselounge.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "baselounge.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "baselounge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "baselounge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "baselounge.labels" -}}
helm.sh/chart: {{ include "baselounge.chart" . }}
{{ include "baselounge.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Образ: тег по умолчанию — appVersion. */}}
{{- define "baselounge.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Домен (обязателен при Gateway/TLS). */}}
{{- define "baselounge.hostname" -}}
{{- required "gateway.hostname обязателен (например 203-0-113-10.sslip.io)" .Values.gateway.hostname }}
{{- end }}

{{- define "baselounge.webappUrl" -}}
{{- if .Values.app.webappUrl }}{{ .Values.app.webappUrl }}{{ else }}https://{{ include "baselounge.hostname" . }}{{ end }}
{{- end }}

{{/* Имя Secret с BOT_TOKEN/DATABASE_URL. */}}
{{- define "baselounge.secretName" -}}
{{- if .Values.existingSecret }}{{ .Values.existingSecret }}{{ else }}{{ include "baselounge.fullname" . }}-secrets{{ end }}
{{- end }}

{{- define "baselounge.tlsSecretName" -}}
{{- printf "%s-tls" .Release.Name }}
{{- end }}

{{/* Gateway, к которому цепляются маршруты. */}}
{{- define "baselounge.gatewayName" -}}
{{- if .Values.gateway.create }}{{ include "baselounge.fullname" . }}{{ else }}{{ required "gateway.existing.name обязателен при gateway.create=false" .Values.gateway.existing.name }}{{ end }}
{{- end }}

{{- define "baselounge.gatewayNamespace" -}}
{{- if .Values.gateway.create }}{{ .Release.Namespace }}{{ else }}{{ default .Release.Namespace .Values.gateway.existing.namespace }}{{ end }}
{{- end }}

{{- define "baselounge.httpsSection" -}}
{{- if .Values.gateway.create }}https{{ else }}{{ required "gateway.existing.sectionName обязателен при gateway.create=false" .Values.gateway.existing.sectionName }}{{ end }}
{{- end }}

{{- define "baselounge.httpSection" -}}
{{- if .Values.gateway.create }}http{{ else }}{{ .Values.gateway.existing.httpSectionName }}{{ end }}
{{- end }}

{{- define "baselounge.issuerName" -}}
{{- if .Values.tls.issuer.name }}{{ .Values.tls.issuer.name }}{{ else }}{{ printf "%s-letsencrypt-%s" (include "baselounge.fullname" .) .Values.tls.acme.env }}{{ end }}
{{- end }}
