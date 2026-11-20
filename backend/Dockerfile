FROM maven:3.9-eclipse-temurin-21-alpine AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -q package

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN apk add --no-cache postgresql16-client && addgroup -S app && adduser -S app -G app \
    && mkdir /app/reset-backups && chown app:app /app/reset-backups
COPY --from=build /app/target/*.jar app.jar
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
